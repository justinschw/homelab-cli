'use strict';
const joi = require('joi');
const { loadInventory, getNextVmId } = require('./function');
const Proxmox = require('./proxmox');
const Executor = require('./executor');
const fs = require('fs');
const {
    populateInventoryRefs,
    populateUpperLevelRefs,
    populateBitwardenRefs
} = require('./function');

function Packer(config) {
    const schema = joi.object({
        name: joi.string().required(),
        version: joi.string().required(),
        iso_url: joi.string().uri().required(),
        iso_file: joi.string().optional(),
        packer_template_url: joi.string().uri().required(),
        network: joi.string().required(),
        variables: joi.object().pattern(joi.string(), joi.string()).optional(),
        inventoryFile: joi.string().required(),
        isoPath: joi.string().default('/var/lib/vz/template/iso/'),
        ssh: joi.object({
            host: joi.string().required(),
            username: joi.string().required(),
            privateKey: joi.string().optional()
        }).optional()
    });
    const { error, value } = schema.validate(config);
    if (error) {
        throw new Error(`Invalid Packer config: ${error.message}`);
    }
    this.config = value;
};

Packer.prototype.init = async function () {
    // Load the inventory file and prepare for packing
    this.inventory = loadInventory(this.config.inventoryFile);
    if (!this.inventory) {
        throw new Error('Failed to load inventory');
    }

    console.info('Populating Bitwarden references in Packer config and inventory...');
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
    console.info('Resolving inventory references in Packer config...');
    this.config = populateInventoryRefs(this.config, this.inventory);

    console.info('Resolving upper level references in Packer config...');
    this.config = populateUpperLevelRefs(this.config);

    let strConfig = JSON.stringify(this.config);
    // fill in host:ip if referenced
    console.info('Getting preseed host IP...');
    const hostIpRegex = /{host:ip}/g;
    const ipMatches = Array.from(strConfig.matchAll(hostIpRegex), m => m[0]);
    for (let i = 0; i < ipMatches.length; i++) {
        const element = ipMatches[i].replace(/{|}/g, '');
        const networkName = this.config.network;
        try {
            const ip = await this.getHttpIp(networkName);
            strConfig = strConfig.replace(ipMatches[i], ip);
            console.info('Preseed will use IP ' + ip + ' on network ' + networkName);
        } catch (err) {
            throw new Error(`Failed to get preseed host IP for network ${networkName}: ${err.message}`);
        }
    }
    this.config = JSON.parse(strConfig);
    this.proxmox = new Proxmox(this.inventory.proxmox);
};

// TODO: method to check if template already exists and up to date

Packer.prototype.getHttpIp = async function (networkName) {
    if (!this.inventory) {
        throw new Error('Inventory not loaded');
    }
    const network = this.inventory.networks.find(net => net.name === networkName);
    if (!network) {
        throw new Error(`Network ${networkName} not found in inventory`);
    }
    const executor = new Executor({
        execution: (this.config.ssh && 'ssh') || 'local',
        ssh: this.config.ssh || {}
    });
    const output = await executor.run('ip', ['addr', 'show']);
    const lines = output.split('\n');
    for (const line of lines) {
        const match = line.trim().match(/inet (\d+\.\d+\.\d+\.\d+)\/\d+/);
        if (match) {
            const ip = match[1];
            const ipToInt = s => s.split('.').reduce((a, b) => ((a << 8) + parseInt(b, 10)) >>> 0, 0) >>> 0;
            const [base, prefix] = (network.subnet || '').split('/');
            const prefixLen = prefix ? parseInt(prefix, 10) : 32;
            if (!base || isNaN(prefixLen) || prefixLen < 0 || prefixLen > 32) {
                continue;
            }
            const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
            const ipInt = ipToInt(ip);
            const baseInt = ipToInt(base) & mask;
            if ((ipInt & mask) === baseInt) {
                return ip;
            }
        }
    }
    throw new Error(`No valid IP found for network ${networkName}`);
}

Packer.prototype.ensureIsoOnProxmox = async function (options = {}) {
    // Ensure the ISO is present on the Proxmox storage
    const isPresent = await this.proxmox.checkForIso(options);
    if (!isPresent) {
        await this.proxmox.downloadIso(options);
        let isPresent = false, retries = 0;
        while (!isPresent && retries < 24) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            isPresent = await this.proxmox.checkForIso(options);
            retries++;
        }
        return;
    }
};

Packer.prototype.build = async function (override = false) {
    // Build the Packer image
    const storage = this.config.iso_file.split(':')[0];
    const isoOptions = {
        storage,
        isoFile: this.config.iso_file,
        isoUrl: this.config.iso_url
    }
    console.info('Ensuring ISO is present on Proxmox storage...');
    await this.ensureIsoOnProxmox(isoOptions);
    const templateInfo = await this.proxmox.getTemplateInfo(this.config.name);
    if (templateInfo) {
        if (!override) {
            // TODO: check version info
            throw new Error(`Template ${this.config.name} already exists and override is not set`);
        } else {
            console.info(`Template exists with id ${templateInfo.vmid}, deleting...`);
            await this.proxmox.deleteTemplate(templateInfo.vmid);
        }
    }

    const vmid = getNextVmId('template', this.inventory);
    console.info(`Using VMID ${vmid} for new template`);
    this.config.variables.id = vmid.toString();

    if (this.config.ssh) {
        console.info('Packer build will be run remotely via SSH on host: ' + this.config.ssh.host);
    } else {
        console.info('Packer build will be run locally');
    }
    const packerBuild = new Executor({
        execution: (this.config.ssh && 'ssh') || 'local',
        ssh: this.config.ssh || {}
    });

    const buildDir = `/tmp/packer_${this.config.name}`;
    await packerBuild.run('git', ['clone', this.config.packer_template_url, buildDir]);
    const env = {
        PWD: buildDir
    };
    Object.keys(this.config.variables || {}).forEach(key => {
        env[`PKR_VAR_${key}`] = this.config.variables[key];
    });
    try {
        console.info('Running Packer build...');
        await packerBuild.run('packer', ['build', buildDir], env, true);
        this.inventory.templates = this.inventory.templates || [];
        const newTemplate = {
            name: this.config.name,
            version: this.config.version,
            vmid: vmid
        }
        const existing = this.inventory.templates.find(t => t.name === this.config.name);
        if (existing) {
            Object.assign(existing, newTemplate);
        } else {
            this.inventory.templates.push(newTemplate);
        }
        console.info('Updating inventory file with new template info...');
        const oldInventory = fs.readFileSync(this.config.inventoryFile, 'utf-8');
        const oldData = JSON.parse(oldInventory);
        oldData.templates = this.inventory.templates;
        fs.writeFileSync(this.config.inventoryFile, JSON.stringify(oldData, null, 2));
        console.info('Packer build completed successfully.');
    } catch (err) {
        await packerBuild.run('rm', ['-rf', buildDir]);
        throw new Error(`Packer build failed: ${err.message}`);
    }
    await packerBuild.run('rm', ['-rf', buildDir]);
}

module.exports = Packer;