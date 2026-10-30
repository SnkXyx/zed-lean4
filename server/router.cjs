// A stdio LSP multiplexer. Runs on Zed's managed Node.js, outside the WASM sandbox.
// Project isolation and dependency-build modes follow leanprover/vscode-lean4
// (Apache-2.0), revision 939ccf20a33406c7c3b4518f152f11630fbd071f:
// vscode-lean4/src/leanclient.ts, utils/clientProvider.ts, utils/converters.ts.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fileURLToPath, pathToFileURL } = require('node:url');

const { findLeanProjectRootInfo, fileExists, isCoreLean4Directory, willUseLakeServer } = require('./project-info.cjs');

const ignored = new Set(['node_modules', 'target']);
const restartCommand = 'zedLean.restartFile';
const hasId = message => Object.hasOwn(message, 'id');
const uriOf = params => params?.textDocument?.uri ?? params?.uri ?? params?.item?.uri;
const asPath = uri => {
  try { return fileURLToPath(uri); } catch { return undefined; }
};
// Project discovery is ported from VS Code's Lean extension (see project-info.cjs).
async function projectRoot(filename, fallback) {
  const info = await findLeanProjectRootInfo(filename, fallback);
  if (info.kind === 'LakefileWithoutToolchain') {
    throw new Error(`Project at ${info.projectRootUri} has a Lakefile but no lean-toolchain file`);
  }
  if (info.kind !== 'Success') throw new Error(`Cannot inspect Lean file: ${filename}`);
  return info.projectRootUri;
}

// Zed requires capabilities before didOpen. Select a bootstrap server using the
// same discovery as documents; this scan does not decide document ownership.
async function initialRoot(worktree) {
  const enclosing = await projectRoot(worktree, worktree);
  if (enclosing !== worktree || await fileExists(path.join(worktree, 'lean-toolchain')) || await isCoreLean4Directory(worktree)) return enclosing;
  const queue = [worktree];
  for (let i = 0; i < queue.length; i++) {
    const dir = queue[i];
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    if (entries.some(entry => entry.name === 'lean-toolchain' && entry.isFile())) {
      return projectRoot(path.join(dir, '_'), worktree);
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !ignored.has(entry.name)) {
        queue.push(path.join(dir, entry.name));
      }
    }
  }
  return worktree;
}

// LSP positions use UTF-16 code units by default, as do JavaScript strings.
function applyChanges(text, changes) {
  for (const change of changes) {
    if (!change.range) { text = change.text; continue; }
    const offset = position => {
      let start = 0;
      for (let line = 0; line < position.line; line++) {
        const end = /\r\n|\r|\n/g;
        end.lastIndex = start;
        const match = end.exec(text);
        if (!match) return text.length;
        start = end.lastIndex;
      }
      const end = text.slice(start).search(/[\r\n]/);
      return Math.min(start + position.character, end < 0 ? text.length : start + end);
    };
    const start = offset(change.range.start);
    const end = offset(change.range.end);
    text = text.slice(0, start) + change.text + text.slice(end);
  }
  return text;
}

function write(stream, message) {
  const body = Buffer.from(JSON.stringify(message));
  stream.write(`Content-Length: ${body.length}\r\n\r\n`);
  stream.write(body);
}

function read(stream, onMessage, onError) {
  let buffer = Buffer.alloc(0);
  stream.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      for (;;) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const match = /(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i.exec(buffer.subarray(0, end).toString());
        if (!match) throw new Error('Missing LSP Content-Length');
        const length = Number(match[1]);
        if (!Number.isSafeInteger(length) || length > 256 * 1024 * 1024) throw new Error('Invalid LSP Content-Length');
        if (buffer.length < end + 4 + length) return;
        const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
        buffer = buffer.subarray(end + 4 + length);
        onMessage(message);
      }
    } catch (error) { onError(error); }
  });
}

class Router {
  constructor(lake, worktree, input = process.stdin, output = process.stdout) {
    this.lake = lake;
    this.worktree = path.resolve(worktree);
    this.output = output;
    this.servers = new Map();
    this.serverQueues = new Map();
    this.clientRequests = new Map();
    this.cancelled = new Set();
    this.serverRequests = new Map();
    this.documents = new Map();
    this.documentContents = new Map();
    this.nextId = 0;
    this.configuration = undefined;
    this.stopping = false;
    this.queue = Promise.resolve();
    read(input, message => {
      // Responses/cancellations must bypass the ordered notification queue: a child
      // can request configuration while initialize or didOpen is still pending.
      if (!message.method) this.clientResponse(message);
      else if (message.method === '$/cancelRequest') this.cancel(message.params?.id);
      else {
        this.queue = this.queue.then(() => this.receive(message)).catch(error => {
          if (hasId(message)) this.reply(message.id, undefined, error);
          else this.log(error.message);
        });
      }
    }, error => { this.log(error.message); this.dispose(1); });
    input.on('end', () => this.dispose(0));
  }

  send(message) { write(this.output, { jsonrpc: '2.0', ...message }); }
  log(message) { this.send({ method: 'window/logMessage', params: { type: 1, message: `[Lake router] ${message}` } }); }
  reply(id, result, error) {
    this.send(error ? { id, error: { code: error.code ?? -32603, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } } : { id, result: result ?? null });
  }

  async server(root) {
    if (this.servers.has(root)) return this.servers.get(root).ready;
    const useLake = await willUseLakeServer(root);
    // Recheck after filesystem IO to avoid starting the same project twice.
    if (this.servers.has(root)) return this.servers.get(root).ready;
    const executable = useLake ? this.lake : path.join(path.dirname(this.lake), process.platform === 'win32' ? 'lean.exe' : 'lean');
    const child = spawn(executable, useLake ? ['serve', '--'] : ['--server'], {
      cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const server = { root, child, pending: new Map(), prefix: `lake:${++this.nextId}:`, dead: false };
    const fail = error => {
      if (server.dead) return;
      server.dead = true;
      // Keep the failed entry until the editor restarts the LSP. Replaying only
      // didChange after a crash would otherwise silently lose open documents.
      for (const { reject } of server.pending.values()) reject(error);
      server.pending.clear();
      for (const [id, request] of this.serverRequests) {
        if (request.server === server) this.serverRequests.delete(id);
      }
      if (!this.stopping) this.log(`${root}: ${error.message}. Restart the Lean language server to retry.`);
    };
    child.on('error', fail);
    child.on('exit', (code, signal) => fail(new Error(`Lake exited (${signal ?? code})`)));
    child.stdin.on('error', fail);
    child.stderr.on('data', chunk => process.stderr.write(`[Lake ${root}] ${chunk}`));
    read(child.stdout, message => this.fromServer(server, message), error => { fail(error); child.kill(); });
    this.servers.set(root, server);
    server.ready = (async () => {
      const uri = pathToFileURL(root).href;
      const result = await this.request(server, 'initialize', {
        ...this.initializeParams, rootPath: root, rootUri: uri,
        workspaceFolders: [{ uri, name: path.basename(root) }],
      });
      server.capabilities = result.capabilities;
      this.notify(server, 'initialized', {});
      if (this.configuration !== undefined) this.notify(server, 'workspace/didChangeConfiguration', this.configuration);
      return server;
    })();
    return server.ready;
  }

  // Serialize document lifecycle and request dispatch within each project, while
  // allowing another project's server to initialize independently. Wrapping the
  // result prevents a long-running request from blocking subsequent notifications.
  withServer(root, action) {
    const queued = (this.serverQueues.get(root) ?? Promise.resolve()).then(async () => {
      const server = await this.server(root);
      return { value: action(server) };
    });
    this.serverQueues.set(root, queued.then(() => {}, () => {}));
    return queued.then(result => result.value);
  }

  notify(server, method, params) {
    if (!server.dead) write(server.child.stdin, { jsonrpc: '2.0', method, params });
  }

  request(server, method, params, clientId) {
    if (server.dead) return Promise.reject(new Error(`Lake server for ${server.root} has stopped`));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      server.pending.set(id, { resolve, reject });
      if (clientId !== undefined) {
        let requests = this.clientRequests.get(clientId);
        if (!requests) this.clientRequests.set(clientId, requests = []);
        requests.push({ server, id });
      }
      write(server.child.stdin, { jsonrpc: '2.0', id, method, params });
      if (this.cancelled.has(clientId)) this.notify(server, '$/cancelRequest', { id });
    });
  }

  cancel(id) {
    this.cancelled.add(id);
    for (const request of this.clientRequests.get(id) ?? []) {
      this.notify(request.server, '$/cancelRequest', { id: request.id });
    }
  }

  clientResponse(message) {
    const request = this.serverRequests.get(message.id);
    if (!request) return;
    this.serverRequests.delete(message.id);
    if (!request.server.dead) write(request.server.child.stdin, { ...message, id: request.id });
  }

  fromServer(server, message) {
    if (!message.method) {
      const pending = server.pending.get(message.id);
      if (!pending) return;
      server.pending.delete(message.id);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message), message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'workspace/workspaceFolders' && hasId(message)) {
      write(server.child.stdin, { jsonrpc: '2.0', id: message.id, result: [{ uri: pathToFileURL(server.root).href, name: path.basename(server.root) }] });
      return;
    }
    // Child request IDs, registrations, and server-created progress tokens are
    // local to each server; make them unique on the shared client connection.
    if (message.method === 'client/registerCapability') {
      for (const registration of message.params.registrations) registration.id = server.prefix + registration.id;
    }
    if (message.method === 'client/unregisterCapability') {
      for (const registration of message.params.unregisterations ?? []) registration.id = server.prefix + registration.id;
    }
    if (message.method === 'workspace/configuration') {
      for (const item of message.params.items) item.scopeUri ??= pathToFileURL(server.root).href;
    }
    if (message.method === 'window/workDoneProgress/create') {
      server.progress ??= new Map();
      server.progress.set(message.params.token, server.prefix + JSON.stringify(message.params.token));
      message.params.token = server.progress.get(message.params.token);
    }
    if (message.method === '$/progress' && server.progress?.has(message.params.token)) {
      message.params.token = server.progress.get(message.params.token);
    }
    if (hasId(message)) {
      const id = server.prefix + JSON.stringify(message.id);
      this.serverRequests.set(id, { server, id: message.id });
      message.id = id;
    }
    this.send(message);
  }

  async rootFor(params) {
    if (params?.data?.__zedLakeRouter) return params.data.__zedLakeRouter.root;
    if (params?.item?.data?.__zedLakeRouter) return params.item.data.__zedLakeRouter.root;
    const commandRoot = params?.arguments?.at(-1)?.__zedLakeCommand;
    if (commandRoot) return commandRoot;
    const uri = uriOf(params);
    const filename = uri && asPath(uri);
    if (filename) return this.documents.get(uri) ?? projectRoot(filename, this.worktree);
    // executeCommand and Lean RPC carry document URIs inside arguments/params.
    const findUri = value => {
      if (typeof value === 'string' && value.startsWith('file:') && asPath(value)) return value;
      if (value && typeof value === 'object') {
        for (const item of Object.values(value)) { const uri = findUri(item); if (uri) return uri; }
      }
    };
    const nestedUri = findUri(params);
    if (nestedUri) return this.documents.get(nestedUri) ?? projectRoot(asPath(nestedUri), this.worktree);
    return undefined;
  }

  tag(result, root, method) {
    const tagCommand = command => {
      if (command && typeof command.command === 'string') {
        command.arguments = [...(command.arguments ?? []), { __zedLakeCommand: root }];
      }
    };
    const tag = item => {
      if (!item || typeof item !== 'object') return;
      item.data = { __zedLakeRouter: { root, present: Object.hasOwn(item, 'data'), value: item.data } };
    };
    if (['textDocument/completion', 'textDocument/codeAction', 'workspace/symbol', 'textDocument/prepareCallHierarchy', 'callHierarchy/incomingCalls', 'callHierarchy/outgoingCalls'].includes(method)) {
      for (const item of Array.isArray(result) ? result : result?.items ?? []) {
        tag(item.from ?? item.to ?? item);
        if (method === 'textDocument/codeAction') tagCommand(typeof item.command === 'string' ? item : item.command);
        if (method === 'textDocument/completion') tagCommand(item.command);
      }
    }
    if (method === 'codeAction/resolve' || method === 'completionItem/resolve') tagCommand(result?.command);
    return result;
  }

  untag(params) {
    if (params?.item?.data?.__zedLakeRouter) return { ...params, item: this.untag(params.item) };
    if (params?.arguments?.at(-1)?.__zedLakeCommand) return { ...params, arguments: params.arguments.slice(0, -1) };
    const data = params?.data?.__zedLakeRouter;
    if (!data) return params;
    const original = { ...params };
    if (data.present) original.data = data.value;
    else delete original.data;
    if (original.command && typeof original.command === 'object') original.command = this.untag(original.command);
    return original;
  }

  async receive(message) {
    const { method, params, id } = message;
    if (method === 'initialize') {
      this.initializeParams = params;
      this.initial = await initialRoot(this.worktree);
      const server = await this.server(this.initial);
      const actions = server.capabilities.codeActionProvider;
      this.capabilities = {
        ...server.capabilities,
        codeActionProvider: {
          ...(typeof actions === 'object' ? actions : {}),
          ...(!actions || actions.codeActionKinds ? {
            codeActionKinds: [...new Set([...(actions?.codeActionKinds ?? []), 'quickfix'])],
          } : {}),
        },
        executeCommandProvider: {
          ...server.capabilities.executeCommandProvider,
          commands: [...new Set([...(server.capabilities.executeCommandProvider?.commands ?? []), restartCommand])],
        },
      };
      this.reply(id, { capabilities: this.capabilities, serverInfo: { name: 'Lean Lake router' } });
      return;
    }
    if (method === 'initialized') return;
    if (method === 'exit') { this.dispose(this.stopping ? 0 : 1); return; }
    if (method === 'shutdown') {
      this.stopping = true;
      await Promise.all([...this.serverQueues.values()]);
      await Promise.all([...this.servers.values()].filter(s => !s.dead).map(s => Promise.race([
        this.request(s, 'shutdown', null).catch(() => {}),
        new Promise(resolve => { const timer = setTimeout(resolve, 3000); timer.unref(); }),
      ])));
      this.reply(id, null);
      return;
    }
    if (method === 'workspace/didChangeConfiguration') {
      this.configuration = params;
      for (const server of this.servers.values()) this.notify(server, method, params);
      return;
    }
    if (method === 'workspace/didChangeWorkspaceFolders') return;
    if (method === 'workspace/didChangeWatchedFiles') {
      for (const server of this.servers.values()) this.notify(server, method, params);
      return;
    }
    if (method === 'window/workDoneProgress/cancel') {
      for (const server of this.servers.values()) {
        for (const [token, mapped] of server.progress ?? []) {
          if (mapped === params.token) this.notify(server, method, { token });
        }
      }
      return;
    }
    if (method === 'textDocument/didOpen') {
      const uri = params.textDocument.uri;
      const filename = asPath(uri);
      if (!filename) return;
      const root = await projectRoot(filename, this.worktree);
      if (this.documents.has(uri)) return;
      this.documents.set(uri, root);
      this.documentContents.set(uri, { ...params.textDocument });
      this.withServer(root, server => this.notify(server, method, {
        ...params, dependencyBuildMode: this.configuration?.settings?.automaticallyBuildDependencies ? 'always' : 'never',
      })).catch(error => this.log(error.message));
      return;
    }
    if (method === 'textDocument/didChange') {
      const document = this.documentContents.get(params.textDocument.uri);
      if (document) {
        document.text = applyChanges(document.text, params.contentChanges);
        document.version = params.textDocument.version;
      }
    }
    if (method === 'workspace/executeCommand' && params.command === restartCommand) {
      // Keep close/open together in the notification queue, ahead of later edits.
      const uri = params.arguments?.[0];
      const document = this.documentContents.get(uri);
      if (!document) throw Object.assign(new Error('The Lean file is no longer open'), { code: -32602 });
      const snapshot = { ...document };
      this.withServer(this.documents.get(uri), server => {
        if (server.dead) throw new Error('Lake has stopped; restart the Lean language server');
        this.notify(server, 'textDocument/didClose', { textDocument: { uri } });
        this.notify(server, 'textDocument/didOpen', {
          textDocument: snapshot,
          dependencyBuildMode: this.configuration?.settings?.automaticallyBuildDependencies ? 'always' : 'once',
        });
      }).then(() => { if (hasId(message)) this.reply(id, null); }, error => {
        if (hasId(message)) this.reply(id, undefined, error); else this.log(error.message);
      });
      return;
    }
    if (method === 'codeAction/resolve' && params.command?.command === restartCommand) {
      this.reply(id, params);
      return;
    }
    if (!hasId(message)) {
      // VS Code filters closes/edits for documents this client never opened.
      if (['textDocument/didChange', 'textDocument/didClose', 'textDocument/didSave'].includes(method) &&
          !this.documents.has(params.textDocument.uri)) return;
      const root = await this.rootFor(params);
      if (root) this.withServer(root, server => this.notify(server, method, params)).catch(error => this.log(error.message));
      else for (const server of this.servers.values()) this.notify(server, method, params);
      if (method === 'textDocument/didClose') {
        this.documents.delete(params.textDocument.uri);
        this.documentContents.delete(params.textDocument.uri);
      }
      return;
    }
    // Do not block the notification queue on requests (e.g. hover while a file
    // elaborates). didChange/didClose and cancellation must remain responsive.
    const root = await this.rootFor(params) ?? this.initial;
    this.routeRequest(message, root).catch(error => this.reply(id, undefined, error)).finally(() => {
      this.clientRequests.delete(id);
      this.cancelled.delete(id);
    });
  }

  async routeRequest({ method, params, id }, root) {
    if (method === 'workspace/symbol') {
      const results = await Promise.allSettled([...this.servers.values()].filter(server => !server.dead).map(async server => {
        await server.ready;
        const { workDoneToken, partialResultToken, ...query } = params;
        return this.tag(await this.request(server, method, query, id), server.root, method) ?? [];
      }));
      const successful = results.filter(result => result.status === 'fulfilled');
      if (!successful.length && results.length) throw results[0].reason;
      this.reply(id, successful.flatMap(result => result.value));
      return;
    }
    return this.withServer(root, server => this.requestFromServer(server, method, params, id, root));
  }

  async requestFromServer(server, method, params, id, root) {
    let result;
    if (method === 'textDocument/codeAction') {
      result = [];
      if (server.capabilities.codeActionProvider) {
        try { result = await this.request(server, method, this.untag(params), id) ?? []; }
        catch (error) { if (error.code !== -32601) throw error; }
      }
      const only = params.context?.only;
      // Source actions may run automatically on save; a restart is always explicit.
      if (this.documentContents.has(params.textDocument.uri) &&
          (!only || only.some(kind => kind === '' || kind === 'quickfix'))) {
        result.push({
          title: 'Lean: Restart File', kind: 'quickfix',
          command: { title: 'Lean: Restart File', command: restartCommand, arguments: [params.textDocument.uri] },
        });
      }
    } else result = await this.request(server, method, this.untag(params), id);
    // Token legends can vary across Lean toolchains; translate into the legend
    // advertised to Zed rather than interpreting token indices from another version.
    if (method.startsWith('textDocument/semanticTokens/') && result?.data) {
      const from = server.capabilities.semanticTokensProvider?.legend;
      const to = this.capabilities.semanticTokensProvider?.legend;
      if (from && to) {
        for (let i = 0; i < result.data.length; i += 5) {
          const type = to.tokenTypes.indexOf(from.tokenTypes[result.data[i + 3]]);
          result.data[i + 3] = Math.max(0, type);
          const modifiers = result.data[i + 4];
          result.data[i + 4] = from.tokenModifiers.reduce((bits, name, index) => {
            const target = to.tokenModifiers.indexOf(name);
            return target >= 0 && (modifiers & (1 << index)) ? bits | (1 << target) : bits;
          }, 0) >>> 0;
        }
      }
    }
    this.reply(id, this.tag(result, root, method));
  }

  dispose(code) {
    this.stopping = true;
    for (const server of this.servers.values()) {
      this.notify(server, 'exit');
      server.child.stdin.end();
      const timer = setTimeout(() => server.child.kill(), 1000);
      timer.unref();
    }
    if (this.output === process.stdout) setTimeout(() => process.exit(code), 1100).unref();
  }
}

module.exports = { Router, projectRoot, initialRoot, applyChanges, read, write };
if (require.main === module) {
  const [, , lake, worktree] = process.argv;
  if (!lake || !worktree) throw new Error('Usage: router.cjs LAKE WORKTREE');
  new Router(lake, worktree);
}
