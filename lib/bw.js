'use strict';
const joi = require('joi');
const {spawn} = require('child_process');

function Bw(options) {
    const schema = joi.object({
        clientId: joi.string().required(),
        clientSecret: joi.string().required(),
        masterpassword: joi.string().optional(),
        executable: joi.string().default('bw'),
        dataDir: joi.string().optional()
    });
    const { error, value } = schema.validate(options);
    if (error) {
        throw new Error(`Invalid options: ${error.message}`);
    }
    this.options = value;
}

Bw.prototype.logout = async function() {
    return new Promise((resolve, reject) => {
        const env = {
            BW_SESSION: this.session,
            BW_DATA_DIR: this.options.dataDir || ''
        };
        const child = spawn(this.options.executable, ['logout'], { stdio: ['ignore', 'pipe', 'pipe'], env });
        let output = '';
        let errorOutput = '';
        child.stdout.on('data', (data) => {
            output += data.toString();
        });
        child.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });
        child.on('close', (code) => {
            if (code === 0) {
                resolve(output.trim());
            } else {
                reject(new Error(`bw logout failed with code ${code}: ${errorOutput.trim()}`));
            }
        });
    });
};

Bw.prototype.login = async function() {
    // Implement login logic here
    return new Promise((resolve, reject) => {
        const env = {
            BW_DATA_DIR: this.options.dataDir || '',
            BW_CLIENTID: this.options.clientId,
            BW_CLIENTSECRET: this.options.clientSecret
        };
        const child = spawn(this.options.executable, ['login', '--apikey'], { stdio: ['ignore', 'pipe', 'pipe'], env });
        let output = '';
        let errorOutput = '';
        child.stdout.on('data', (data) => {
            output += data.toString();
        });
        child.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });
        child.on('close', (code) => {
            if (code === 0 || code === 1) { // bw login returns 1 when already logged in
                resolve(output.trim());
            } else {
                reject(new Error(`bw login failed with code ${code}: ${errorOutput.trim()}`));
            }
        });
    });    
}

Bw.prototype.lock = async function() {
    return new Promise((resolve, reject) => {
        const env = {
            BW_DATA_DIR: this.options.dataDir || '',
            BW_SESSION: this.session
        };
        const child = spawn(this.options.executable, ['lock'], { stdio: ['ignore', 'pipe', 'pipe'], env });
        let output = '';
        let errorOutput = '';
        child.stdout.on('data', (data) => {
            output += data.toString();
        });
        child.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });
        child.on('close', (code) => {
            if (code === 0 || code === 1) { // bw lock returns 1 when already locked
                resolve(output.trim());
            } else {
                reject(new Error(`bw lock failed with code ${code}: ${errorOutput.trim()}`));
            }
        });
    });
};

Bw.prototype.unlock = async function() {
    return new Promise((resolve, reject) => {
        const env = {
            BW_DATA_DIR: this.options.dataDir || '',
            BW_CLIENTID: this.options.clientId,
            BW_CLIENTSECRET: this.options.clientSecret,
            BW_PASSWORD: this.options.masterpassword || ''
        };
        const child = spawn(this.options.executable, ['unlock', '--passwordenv', 'BW_PASSWORD', '--raw'], { stdio: ['ignore', 'pipe', 'pipe'], env });
        let output = '';
        let errorOutput = '';
        child.stdout.on('data', (data) => {
            output += data.toString();
        });
        child.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });
        child.on('close', (code) => {
            if (code === 0 || code === 1) { // bw unlock returns 1 when already unlocked
                this.session = output.trim();
                resolve(output.trim());
            } else {
                reject(new Error(`bw unlock failed with code ${code}: ${errorOutput.trim()}`));
            }
        });
    });
};

Bw.prototype.list = async function() {
    return new Promise((resolve, reject) => {
        const env = {
            BW_DATA_DIR: this.options.dataDir || '',
            BW_SESSION: this.session
        };
        const child = spawn(this.options.executable, ['list', 'items'], { stdio: ['ignore', 'pipe', 'pipe'], env });
        let output = '';
        let errorOutput = '';
        child.stdout.on('data', (data) => {
            output += data.toString();
        });
        child.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });
        child.on('close', (code) => {
            if (code === 0 && output.trim()) {
                this.secrets = JSON.parse(output.trim());
                resolve(this.secrets);
            } else {
                reject(new Error(`bw list failed with code ${code}: ${errorOutput.trim()}`));
            }
        });
    });
};

Bw.prototype.fill = async function(config) {
    let strConfig = JSON.stringify(config);
    const bwRefRegex = /"bw:([^"]+)"/g;
    const bwMatches = Array.from(strConfig.matchAll(bwRefRegex), m => m[0]);
    for (let i = 0; i < bwMatches.length; i++) {
        const element = bwMatches[i].replace(/"/g, '');
        const reference = element.replace('bw:', '');
        const name = reference.split('.')[0];
        if(!this.secrets) {
            await this.list();
        }
        const bwSecret = this.secrets.find(s => s.name === name);
        if(!bwSecret) {
            // Secret not found; let's not populate it for now. Maybe later we can throw an error here.
            continue;
        }
        const path = reference.split('.').slice(1);
        let current = bwSecret;
        path.forEach(part => {
            if (Array.isArray(current)) {
                current = current.find(c => c.name === part);
            } else {
                current = current[part];
            }
        });
        if (typeof current === 'string') {
            strConfig = strConfig.replace(`"bw:${reference}"`, `"${current}"`);
        }
    }
    return JSON.parse(strConfig);
};

module.exports = Bw;