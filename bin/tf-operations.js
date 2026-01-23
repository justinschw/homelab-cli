#!/usr/bin/env node
"use strict";
const fs = require('fs');
const path = require('path');

function usage() {
    console.error(`Usage: tf-operations.js --manifest <manifest.json> [--bw-auth <auth.json>]`);
    console.error(`
Flags:
  --manifest   JSON manifest file for Packer (required)
  --bw-auth    Optional Bitwarden auth JSON (client id/secret). Overrides env vars
  --help       Show this help message
`);
}

function parseArgs(argv) {
    const args = { manifest: null, bwAuth: null };
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
        if (a.startsWith('--bw-auth=')) {
            args.bwAuth = a.split('=')[1];
            continue;
        }
        if (a === '--bw-auth') {
            args.bwAuth = argv[++i];
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
        if (a === '--destroy') {
            args.destroy = true;
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

    let terraform;
    try {
        if (args.bwAuth) loadAuth(args.bwAuth);

        const manifestPath = path.resolve(process.cwd(), args.manifest);
        if (!fs.existsSync(manifestPath)) throw new Error(`manifest file not found: ${args.manifest}`);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (args.inventoryFile) {
            const inventoryPath = path.resolve(process.cwd(), args.inventoryFile);
            if (!fs.existsSync(inventoryPath)) throw new Error(`inventory file not found: ${args.inventoryFile}`);
            manifest.tf.inventoryFile = inventoryPath;
        }
        const Terraform = require('../lib/terraform');
        terraform = new Terraform(manifest);
        await terraform.init(args.destroy);
        if (args.destroy) {
            await terraform.plan(args.destroy, true);
            await terraform.apply();
            console.log('Terraform destroy finished successfully');
        } else {
            await terraform.plan(args.destroy, true);
            await terraform.apply();
            console.log('Terraform apply finished successfully');
        }
        await terraform.cleanup();
        process.exit(0);
    } catch (err) {
        console.error('Terraform deploy failed:', err && err.message ? err.message : err);
        if (terraform) await terraform.cleanup();
        process.exit(1);
    }
})();
