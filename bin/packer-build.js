#!/usr/bin/env node
"use strict";
const fs = require('fs');
const path = require('path');

function usage() {
    console.error(`Usage: packer-build.js --manifest <manifest.json> [--bw-auth <auth.json>]`);
    console.error(`
Flags:
  --manifest   JSON manifest file for Packer (required)
  --bw-auth    Optional Bitwarden auth JSON (client id/secret). Overrides env vars
  --ssh-info   Optional JSON file with SSH connection info to inject into manifest
  --help       Show this help message
`);
}

function parseArgs(argv) {
    const args = { manifest: null, bwAuth: null, sshInfo: null, override: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') {
            args.help = true;
            break;
        }
        if (a.startsWith('--manifest=')) {
            args.manifest = a.split('=')[1];
            continue;
        }
        if (a === '--manifest') {
            args.manifest = argv[++i];
            continue;
        }
        if (a.startsWith('--ssh-info=')) {
            args.sshInfo = a.split('=')[1];
            continue;
        }
        if (a === '--ssh-info') {
            args.sshInfo = argv[++i];
            continue;
        }
        if (a.startsWith('--bw-auth=')) {
            args.bwAuth = a.split('=')[1];
            continue;
        }
        if (a === '--bw-auth') {
            args.bwAuth = argv[++i];
            continue;
        }
        if (a === '--override') {
            // ignore for now
            args.override = true;
            continue;
        }
        if (a.startsWith('--inventory-file=')) {
            args.inventoryFile = a.split('=')[1];
            continue;
        }
        if (a === '--inventory-file') {
            args.inventoryFile = argv[++i];
            continue;
        }
    }
    return args;
}

function loadAuth(authPath) {
    const abs = path.resolve(process.cwd(), authPath);
    if (!fs.existsSync(abs)) throw new Error(`bw auth file not found: ${authPath}`);
    const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
    // Accept a few common key names
    const clientId = data.BW_CLIENTID || data.clientId || data.client_id;
    const clientSecret = data.BW_CLIENTSECRET || data.clientSecret || data.client_secret;
    if (!clientId || !clientSecret) throw new Error('auth file missing client id/secret');
    process.env.BW_CLIENTID = clientId;
    process.env.BW_CLIENTSECRET = clientSecret;
}

function loadSshInfo(sshInfoPath) {
    const abs = path.resolve(process.cwd(), sshInfoPath);
    if (!fs.existsSync(abs)) throw new Error(`ssh info file not found: ${sshInfoPath}`);
    const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
    return data;
}

(async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        usage();
        process.exit(0);
    }
    if (!args.manifest) {
        console.error('Error: --manifest is required');
        usage();
        process.exit(2);
    }
    if (!args.inventoryFile) {
        console.error('Error: --inventory-file is required');
        usage();
        process.exit(2);
    }

    try {
        if (args.bwAuth) loadAuth(args.bwAuth);

        const manifestPath = path.resolve(process.cwd(), args.manifest);
        if (!fs.existsSync(manifestPath)) throw new Error(`manifest file not found: ${args.manifest}`);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (args.sshInfo) {
            manifest.ssh = loadSshInfo(args.sshInfo);
        }
        if (args.inventoryFile) {
            const inventoryPath = path.resolve(process.cwd(), args.inventoryFile);
            if (!fs.existsSync(inventoryPath)) throw new Error(`inventory file not found: ${args.inventoryFile}`);
            manifest.inventoryFile = inventoryPath;
        }
        const Packer = require('../lib/packer');
        const packer = new Packer(manifest);
        await packer.init();
        await packer.build(args.override);
        console.log('Packer build finished successfully');
        process.exit(0);
    } catch (err) {
        console.error('Packer build failed:', err && err.message ? err.message : err);
        process.exit(1);
    }
})();
