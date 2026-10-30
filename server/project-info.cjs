// SPDX-License-Identifier: Apache-2.0
// Adapted from leanprover/vscode-lean4, vscode-lean4/src/utils/projectInfo.ts
// Derived from the work of the vscode-lean4 contributors.
// Revision: 939ccf20a33406c7c3b4518f152f11630fbd071f
// https://github.com/leanprover/vscode-lean4
// Modified for Zed: CommonJS, filesystem paths instead of VS Code URI wrappers,
// support new unsaved files, and require complete .lake/packages path components.
// Distributed under Apache-2.0; see LICENSE.txt supplied with this extension.
const fs = require('node:fs');
const path = require('node:path');
async function hasType(filename, type) {
    try { return (await fs.promises.stat(filename))[type](); } catch { return false; }
}
const fileExists = filename => hasType(filename, 'isFile');
const dirExists = filename => hasType(filename, 'isDirectory');

async function isCoreLean4Directory(directory) {
    const licensePath = path.join(directory, 'LICENSE')
    const licensesPath = path.join(directory, 'LICENSES')
    const srcPath = path.join(directory, 'src')

    const isCoreLean4RootDirectory =
        (await fileExists(licensePath)) && (await fileExists(licensesPath)) && (await dirExists(srcPath))
    if (isCoreLean4RootDirectory) {
        return true
    }

    const initPath = path.join(directory, 'Init.lean')
    const leanPath = path.join(directory, 'Lean.lean')
    const kernelPath = path.join(directory, 'kernel')
    const runtimePath = path.join(directory, 'runtime')

    const isCoreLean4SrcDirectory =
        (await fileExists(initPath)) &&
        (await fileExists(leanPath)) &&
        (await dirExists(kernelPath)) &&
        (await dirExists(runtimePath))
    return isCoreLean4SrcDirectory
}

function parentDirOf(uri, subpath) {
    const numComponents = subpath.split(path.sep).length
    let p = path.normalize(uri)
    const i = (p + path.sep).indexOf(path.sep + subpath + path.sep)
    if (i === -1) {
        return undefined
    }
    p = p.slice(0, i + 1 + subpath.length)
    // Ensures that there is no trailing `/`.
    for (let n = 0; n < numComponents; n++) {
        p = path.dirname(p)
    }
    return p
}

function routePackagesDir(uri) {
    // `lean-toolchain` files in `.lake/packages` are ignored because
    // the appropriate project scope for dependencies of a project is the root directory of the project.
    // Technically, Lake allows configuring the location of the packages directory, so the extension may not be able to figure out
    // the correct project scope for a dependency when this setting is set.
    // In the future, Lake may maintain a back-link from the directory of dependencies back to the project root,
    // but for now, this heuristic must suffice.
    return parentDirOf(uri, path.join('.lake', 'packages')) ?? uri
}


async function findLeanProjectRootInfo(uri, workspace) {
    let uriDir
    try {
        if ((await fs.promises.stat(uri)).isFile()) {
            uriDir = path.dirname(uri)
        } else {
            uriDir = uri
        }
    } catch (e) {
        // Zed also opens new, unsaved files with a file URI.
        if (e.code !== 'ENOENT') return { kind: 'FileNotFound' }
        uriDir = path.dirname(uri)
    }

    let currentDir = routePackagesDir(uriDir)

    while (true) {
        const leanToolchain = path.join(currentDir, 'lean-toolchain')
        const lakefileLean = path.join(currentDir, 'lakefile.lean')
        const lakefileToml = path.join(currentDir, 'lakefile.toml')
        if (await fileExists(leanToolchain)) {
            return { kind: 'Success', projectRootUri: currentDir, toolchainUri: leanToolchain }
        }
        if (await isCoreLean4Directory(currentDir)) {
            return { kind: 'Success', projectRootUri: currentDir, toolchainUri: undefined }
        }
        if (await fileExists(lakefileLean)) {
            return { kind: 'LakefileWithoutToolchain', projectRootUri: currentDir, lakefileUri: lakefileLean }
        }
        if (await fileExists(lakefileToml)) {
            return { kind: 'LakefileWithoutToolchain', projectRootUri: currentDir, lakefileUri: lakefileToml }
        }

        const parentDir = path.dirname(currentDir)
        if (parentDir === currentDir) {
            break
        }
        currentDir = parentDir
    }

    // No `lean-toolchain` or core directory found.
    // If the file is in a workspace folder, we use the workspace folder,
    // and otherwise we use the immediate directory that the file is contained in.
    // In nested workspace folders, VS Code yields the innermost one.
    const relative = workspace && path.relative(workspace, uri)
    const workspaceDir = workspace && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) ? workspace : undefined
    if (workspaceDir !== undefined) {
        return { kind: 'Success', projectRootUri: workspaceDir, toolchainUri: undefined }
    }

    return { kind: 'Success', projectRootUri: uriDir, toolchainUri: undefined }
}

// Ported from willUseLakeServer in the same upstream file.
async function willUseLakeServer(directory) {
    return (await fileExists(path.join(directory, 'lakefile.lean'))) ||
        (await fileExists(path.join(directory, 'lakefile.toml')))
}

module.exports = { findLeanProjectRootInfo, routePackagesDir, isCoreLean4Directory, willUseLakeServer, fileExists };
