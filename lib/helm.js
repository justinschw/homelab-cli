'use strict';

const Executor = require('./executor');
const joi = require('joi');
const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');
const os = require('os');
const S3 = require('./s3');

const {
    loadInventory,
    populateInventoryRefs,
    populateUpperLevelRefs,
    populateBitwardenRefs
} = require('./function');

function Helm(config) {
    const schema = joi.object({
        helm: joi.object({
            clusterConfig: joi.object({
                s3: joi.object({
                    endpoint: joi.string().required(),
                    access_key: joi.string().required(),
                    secret_key: joi.string().required(),
                    bucket: joi.string().required(),
                    region: joi.string().required()
                }).optional(),
                location: joi.string().valid('filesystem', 's3').default('filesystem'),
                path: joi.string().required()
            }).required(),
            homelab_inventory_file: joi.string().required(),
            charts: joi.array().items(joi.object(
                {
                    name: joi.string().required(),
                    helmRepo: joi.string().required(),
                    repoName: joi.string().required(),
                    helmChart: joi.string().required(),
                    namespace: joi.string().optional(),
                    version: joi.string().optional(),
                    createNamespace: joi.boolean().default(false),
                    values: joi.object().optional(),
                    force: joi.boolean().default(false)
                }))
        }).required(),
    }).required();
    const { error, value } = schema.validate(config, { allowUnknown: true, stripUnknown: false });
    if (error) {
        throw new Error(`Invalid Helm config: ${error.message}`);
    }
    this.config = value;
    this.command = new Executor();
    this.varsFiles = [];
};

Helm.prototype.downloadS3File = async function (sourcePath, destPath) {
    const s3 = new S3(this.config.helm.clusterConfig.s3);
    await s3.getS3File(sourcePath, destPath);
}

Helm.prototype.getReleases = async function(chart) {
    const listArgs = ['list', '-o', 'json'];
    if (chart.namespace) {
        listArgs.push('--namespace', chart.namespace);
    }
    const stdout = await this.command.run('helm', listArgs, { KUBECONFIG: this.kubeConfigPath }, false);
    const releases = JSON.parse(stdout);
    return releases;
}

Helm.prototype.init = async function () {
    // Load the inventory file
    this.inventory = loadInventory(this.config.helm.homelab_inventory_file);
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
    console.info('Resolving inventory references in helm config...');
    this.config = populateInventoryRefs(this.config, this.inventory);

    console.info('Resolving upper level references in helm config...');
    this.config = populateUpperLevelRefs(this.config);

    // Locate kubeconfig
    if (this.config.helm.clusterConfig?.s3) {
        const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hlcli-helm-'));
        const kubeConfigPath = path.join(tmpdir, path.basename(this.config.helm.clusterConfig.path));
        await this.downloadS3File(this.config.helm.clusterConfig.path, kubeConfigPath);
        this.kubeConfigPath = kubeConfigPath;
    } else {
        this.kubeConfigPath = this.config.helm.clusterConfig.path;
    }
}

Helm.prototype.helmInstall = async function () {
    console.info('Installing Helm charts...');
    for (const chart of this.config.helm.charts) {
        const releases = await this.getReleases(chart);
        if (releases.some(r => r.name === chart.name) && !chart.force) {
            console.info(`Helm chart ${chart.name} is already installed. Skipping...`);
            continue;
        }
        const repoArgs = ['repo', 'add', chart.repoName, chart.helmRepo];
        await this.command.run('helm', repoArgs, {}, true);
        const updateArgs = ['repo', 'update'];
        await this.command.run('helm', updateArgs, {}, true);
        const installArgs = ['upgrade', '--install', chart.name, `${chart.repoName}/${chart.helmChart}`];
        if (chart.version) {
            installArgs.push('--version', chart.version);
        }
        if (chart.namespace) {
            if (chart.createNamespace) {
                installArgs.push('--create-namespace');
            }
            installArgs.push('--namespace', chart.namespace);
        }
        if (chart.values) {
            const valuesFilePath = path.join(os.tmpdir(), `${chart.name}-values.yaml`);
            fs.writeFileSync(valuesFilePath, yaml.dump(chart.values), 'utf8');
            installArgs.push('-f', valuesFilePath);
            this.varsFiles.push(valuesFilePath);
        }
        await this.command.run('helm', installArgs, { KUBECONFIG: this.kubeConfigPath }, true);
        console.info(`Helm chart ${chart.name} installed/updated successfully.`);
    }
};

Helm.prototype.cleanup = async function () {
    // Remove temporary values files
    for (const filePath of this.varsFiles) {
        if (fs.existsSync(filePath)) {
            // zero out file before deleting for security
            fs.writeFileSync(filePath, '', 'utf8');
            fs.unlinkSync(filePath);
        }
    }
    this.varsFiles = [];
}

module.exports = Helm;