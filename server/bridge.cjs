// A single-server LSP bridge running on Zed's managed Node.js.
// Dependency-build modes and file restart follow leanprover/vscode-lean4
// (Apache-2.0), revision 939ccf20a33406c7c3b4518f152f11630fbd071f:
// vscode-lean4/src/leanclient.ts, utils/converters.ts.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const restartCommand = 'zedLean.restartFile';
const hasId = message => Object.hasOwn(message, 'id');

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

class Bridge {
  constructor(lake, directory, input = process.stdin, output = process.stdout) {
    this.directory = path.resolve(directory);
    this.output = output;
    this.documents = new Map();
    this.pending = new Map();
    this.configuration = undefined;
    this.stopping = false;
    this.dead = false;
    const useLake = ['lakefile.lean', 'lakefile.toml'].some(name => {
      try { return fs.statSync(path.join(this.directory, name)).isFile(); } catch { return false; }
    });
    const executable = useLake ? lake : path.join(path.dirname(lake), process.platform === 'win32' ? 'lean.exe' : 'lean');
    this.child = spawn(executable, useLake ? ['serve', '--'] : ['--server'], {
      cwd: this.directory, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => this.fail(new Error(`Lean exited (${signal ?? code})`)));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.stderr.on('data', chunk => process.stderr.write(chunk));
    read(this.child.stdout, message => this.fromServer(message), error => { this.fail(error); this.child.kill(); });
    read(input, message => {
      try { this.receive(message); }
      catch (error) {
        if (hasId(message)) this.reply(message.id, undefined, error);
        else this.log(error.message);
      }
    }, error => { this.log(error.message); this.dispose(1); });
    input.on('end', () => this.dispose(0));
  }

  send(message) { write(this.output, { jsonrpc: '2.0', ...message }); }
  forward(message) { write(this.child.stdin, { jsonrpc: '2.0', ...message }); }
  reply(id, result, error) {
    this.send(error ? { id, error: { code: error.code ?? -32603, message: error.message } } : { id, result: result ?? null });
  }
  log(message) { this.send({ method: 'window/logMessage', params: { type: 1, message: `[Lean bridge] ${message}` } }); }

  fail(error) {
    if (this.dead) return;
    this.dead = true;
    for (const id of this.pending.keys()) this.reply(id, undefined, error);
    this.pending.clear();
    if (!this.stopping) this.log(`${error.message}. Restart the Lean language server to retry.`);
  }

  fromServer(message) {
    if (!message.method) {
      const request = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (request?.method === 'initialize' && message.result) {
        const capabilities = message.result.capabilities;
        const actions = capabilities.codeActionProvider;
        this.hasCodeActions = !!actions;
        capabilities.codeActionProvider = {
          ...(typeof actions === 'object' ? actions : {}),
          ...(!actions || actions.codeActionKinds ? {
            codeActionKinds: [...new Set([...(actions?.codeActionKinds ?? []), 'quickfix'])],
          } : {}),
        };
        capabilities.executeCommandProvider = {
          ...capabilities.executeCommandProvider,
          commands: [...new Set([...(capabilities.executeCommandProvider?.commands ?? []), restartCommand])],
        };
      }
      if (request?.method === 'textDocument/codeAction') {
        if (message.error?.code === -32601) { delete message.error; message.result = []; }
        if (!message.error) message.result = this.codeActions(message.result, request.params);
      }
    }
    this.send(message);
  }

  codeActions(actions, params) {
    const result = actions ?? [];
    const only = params.context?.only;
    // A source action could run on save; restarting must remain explicit.
    if (this.documents.has(params.textDocument.uri) &&
        (!only || only.some(kind => kind === '' || kind === 'quickfix'))) {
      result.push({
        title: 'Lean: Restart File', kind: 'quickfix',
        command: { title: 'Lean: Restart File', command: restartCommand, arguments: [params.textDocument.uri] },
      });
    }
    return result;
  }

  receive(message) {
    const { method, params, id } = message;
    if (this.dead) {
      if (method && hasId(message)) throw new Error('Lean has stopped; restart the Lean language server');
      if (method === 'exit') this.dispose(0);
      return;
    }
    if (method === 'initialize') {
      const uri = pathToFileURL(this.directory).href;
      message = { ...message, params: {
        ...params, rootPath: this.directory, rootUri: uri,
        workspaceFolders: [{ uri, name: path.basename(this.directory) }],
      } };
    }
    if (method === 'workspace/didChangeConfiguration') this.configuration = params;
    if (method === 'textDocument/didOpen') {
      this.documents.set(params.textDocument.uri, { ...params.textDocument });
      message = { ...message, params: {
        ...params, dependencyBuildMode: this.configuration?.settings?.automaticallyBuildDependencies ? 'always' : 'never',
      } };
    }
    if (method === 'textDocument/didChange') {
      const document = this.documents.get(params.textDocument.uri);
      if (document) {
        document.text = applyChanges(document.text, params.contentChanges);
        document.version = params.textDocument.version;
      }
    }
    if (method === 'textDocument/didClose') this.documents.delete(params.textDocument.uri);
    if (method === 'workspace/executeCommand' && params.command === restartCommand) {
      const uri = params.arguments?.[0];
      const document = this.documents.get(uri);
      if (!document) throw Object.assign(new Error('The Lean file is no longer open'), { code: -32602 });
      this.forward({ method: 'textDocument/didClose', params: { textDocument: { uri } } });
      this.forward({ method: 'textDocument/didOpen', params: {
        textDocument: { ...document },
        dependencyBuildMode: this.configuration?.settings?.automaticallyBuildDependencies ? 'always' : 'once',
      } });
      if (hasId(message)) this.reply(id, null);
      return;
    }
    if (method === 'codeAction/resolve' && params.command?.command === restartCommand) {
      this.reply(id, params);
      return;
    }
    if (method === 'textDocument/codeAction' && !this.hasCodeActions) {
      this.reply(id, this.codeActions([], params));
      return;
    }
    if (method === 'shutdown') this.stopping = true;
    if (method === 'exit') { this.dispose(this.stopping ? 0 : 1); return; }
    if (method && hasId(message)) this.pending.set(id, { method, params });
    this.forward(message);
  }

  dispose(code) {
    if (this.disposed) return;
    this.disposed = true;
    this.stopping = true;
    if (!this.dead) this.forward({ method: 'exit' });
    this.child.stdin.end();
    const timer = setTimeout(() => { if (!this.dead) this.child.kill(); }, 1000);
    timer.unref();
    if (this.output === process.stdout) setTimeout(() => process.exit(code), 1100).unref();
  }
}

module.exports = { Bridge, applyChanges, read, write };
if (require.main === module) {
  const [, , lake, directory] = process.argv;
  if (!lake || !directory) throw new Error('Usage: bridge.cjs LAKE PROJECT_DIRECTORY');
  new Bridge(lake, directory);
}
