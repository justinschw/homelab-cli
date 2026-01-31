'use strict';

const Executor = require('./executor');
const axios = require('axios');
const S3 = require('./s3');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const https = require('https');
const joi = require('joi');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
    loadInventory,
    populateInventoryRefs,
    populateUpperLevelRefs,
    populateBitwardenRefs
} = require('./function');

function Ansible(config) {
    const schema = joi.object({
        name: joi.string().required(),
        description: joi.string().optional(),
        ansible: joi.object({
            repository: joi.string().required(),
            branch: joi.string().required(),
            playbook: joi.string().required(),
            s3: joi.object({
                endpoint: joi.string().required(),
                access_key: joi.string().required(),
                secret_key: joi.string().required(),
                bucket: joi.string().required(),
                region: joi.string().required()
            }).optional(),
            homelab_inventory_file: joi.string().required(),
            ansible_inventory_file: joi.string().required(),
            vars_files: joi.array().items(joi.string()).optional(),
            extra_vars: joi.object().optional(),
            ssh_key: joi.string().optional(),
        }).required()
    });
    const { error, value } = schema.validate(config, { allowUnknown: true, stripUnknown: false });
    if (error) {
        throw new Error(`Invalid Ansible config: ${error.message}`);
    }
    this.config = value;
    this.command = new Executor();
}

Ansible.prototype.getS3File = async function (sourcePath, destPath) {
    const s3 = new S3(this.config.ansible.s3);
    await s3.getS3File(sourcePath, destPath);
}

Ansible.prototype.init = async function () {
    // Load the inventory file
    this.inventory = loadInventory(this.config.ansible.homelab_inventory_file);
    if (!this.inventory) {
        throw new Error('Failed to load inventory');
    }

    console.info('Populating Bitwarden references in terraform config and inventory...');
    try {
        const result = await populateBitwardenRefs(this.config, this.inventory, {
            clientId: process.env.BW_CLIENTID,
            clientSecret: process.env.BW_CLIENTSECRET,
            masterpassword: process.env.BW_MASTERPASSWORD,
            dataDir: process.env.BW_DATA_DIR
        });
        this.config = result.config;
        this.inventory = result.inventory;
    } catch (err) {
        throw new Error(`Failed to populate Bitwarden references: ${err.message}`);
    }

    // Populate fields from inventory if they reference it
    console.info('Resolving inventory references in ansible config...');
    this.config = populateInventoryRefs(this.config, this.inventory);

    console.info('Resolving upper level references in ansible config...');
    this.config = populateUpperLevelRefs(this.config);

    // Checkout ansible repository
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hlcli-ansible-'));
    console.info(`Cloning Ansible repository ${this.config.ansible.repository} into ${tmpdir}...`);
    const cloneArgs = ['clone', this.config.ansible.repository, '-b', this.config.ansible.branch, tmpdir];
    await this.command.run('git', cloneArgs, { log: false });
    this.clonedDir = tmpdir;

    // Download files from S3 if configured
    this.inventoryFile = this.config.ansible.ansible_inventory_file;
    this.vars_files = this.config.ansible.vars_files || [];
    if (this.config.ansible.s3) {
        console.info('Downloading Ansible files from S3...');
        const destPath = this.clonedDir;
        // get inventory file
        const inventoryFileName = path.basename(this.inventoryFile);
        const inventoryDest = path.join(destPath, inventoryFileName);
        await this.getS3File(this.inventoryFile, inventoryDest);
        this.inventoryFile = inventoryDest;
        // get vars files
        const newVarsFiles = [];
        for (const varsFile of this.vars_files) {
            const varsFileName = path.basename(varsFile);
            const varsDest = path.join(destPath, varsFileName);
            await this.getS3File(varsFile, varsDest);
            newVarsFiles.push(varsDest);
        }
        this.vars_files = newVarsFiles;
    }
    // Generate extra vars file if needed
    if (this.config.ansible.extra_vars) {
        const extraVarsPath = path.join(this.clonedDir, 'extra_vars.json');
        fs.writeFileSync(extraVarsPath, JSON.stringify(this.config.ansible.extra_vars, null, 2), 'utf8');
        this.vars_files.push(extraVarsPath);
    }
    // Write SSH key file if needed
    if (this.config.ansible.ssh_key) {
        const sshKeyPath = path.join(this.clonedDir, 'ansible_ssh_key');
        // check if key is base64 encoded
        let isBase64 = false;
        try {
            Buffer.from(this.config.ansible.ssh_key, 'base64').toString('utf8');
            isBase64 = true;
        } catch (err) {
            isBase64 = false;
        }
        if (isBase64) {
            const decodedKey = Buffer.from(this.config.ansible.ssh_key, 'base64').toString('utf8');
            fs.writeFileSync(sshKeyPath, decodedKey, { mode: 0o600 });
        } else {
            fs.writeFileSync(sshKeyPath, this.config.ansible.ssh_key, { mode: 0o600 });
        }
        //
        this.ansible_ssh_key = sshKeyPath;
    }
}

Ansible.prototype.runPlaybook = async function () {
    const playbookPath = path.join(this.clonedDir, this.config.ansible.playbook);
    if (!fs.existsSync(playbookPath)) {
        throw new Error(`Ansible playbook not found: ${playbookPath}`);
    }
    const args = ['-i', this.inventoryFile, playbookPath, '--ssh-common-args="-o StrictHostKeyChecking=no"'];
    for (const varsFile of this.vars_files) {
        args.push('-e', `@${varsFile}`);
    }
    if (this.ansible_ssh_key) {
        args.push('--private-key', this.ansible_ssh_key);
    }
    console.info(`Running Ansible playbook ${this.config.ansible.playbook}...`);
    await this.command.run('ansible-playbook', args, { cwd: this.clonedDir }, true);
}

Ansible.prototype.cleanup = async function () {
    if (this.clonedDir && fs.existsSync(this.clonedDir)) {
        // Secure erase SSH key file if exists
        if (this.ansible_ssh_key && fs.existsSync(this.ansible_ssh_key)) {
            fs.writeFileSync(this.ansible_ssh_key, '', { mode: 0o600 });
        }
        // Secure erase extra vars file if exists
        const extraVarsPath = path.join(this.clonedDir, 'extra_vars.json');
        if (fs.existsSync(extraVarsPath)) {
            fs.writeFileSync(extraVarsPath, '', { mode: 0o600 });
        }
        console.info(`Removing temporary directory ${this.clonedDir}...`);
        fs.rmSync(this.clonedDir, { recursive: true, force: true });
    }
}

module.exports = Ansible;