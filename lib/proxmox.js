'use strict';
const axios = require('axios');
const joi = require('joi');
const https = require('https');

function Proxmox(config) {
    const schema = joi.object({
        endpoint: joi.string().required(),
        username: joi.string().required(),
        password: joi.string().required(),
        api_user: joi.string().required(),
        api_token: joi.string().required(),
        node: joi.string().required()
    });
    const { error, value } = schema.validate(config);
    if (error) {
        throw new Error(`Invalid Proxmox config: ${error.message}`);
    }
    this.config = value;
}

Proxmox.prototype.checkForIso = async function (options) {
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });
    let apiUrl = this.config.endpoint;
    if (apiUrl.indexOf('https') < 0) {
        apiUrl = 'https://' + apiUrl;
    }
    const schema = joi.object({
        storage: joi.string().required(),
        isoFile: joi.string().required()
    });
    const { error, value } = schema.validate(options, { allowUnknown: true });
    if (error) {
        throw new Error(`Invalid checkForIso options: ${error.message}`);
    }
    const {
        storage,
        isoFile
    } = value;

    // prepare headers/auth
    const instance = axios.create({ baseURL: apiUrl, timeout: 120000, validateStatus: s => s < 500 });
    let headers = {};

    headers.Authorization = `PVEAPIToken=${this.config.api_user}=${this.config.api_token}`;

    // check storage content for iso
    try {
        const listResp = await instance.get(
            `/api2/json/nodes/${encodeURIComponent(this.config.node)}/storage/${encodeURIComponent(storage)}/content`,
            { httpsAgent, headers, params: { content: 'iso' } }
        );
        if (listResp.status === 200 && Array.isArray(listResp.data.data)) {
            const found = listResp.data.data.find(item => {
                if (item?.volid === isoFile) {
                    return true;
                } else {
                    return false;
                }
            });
            if (found) {
                return true;
            } else {
                return false;
            }
        } else {
            throw new Error(`Listing failed with ${listResp.status}: ${listResp.data?.errors || 'unknown error'}`);
        }
    } catch (err) {
        throw new Error(`Failed to list storage content: ${err.message}`);
    }
};

Proxmox.prototype.downloadIso = async function (options) {
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });
    let apiUrl = this.config.endpoint;
    if (apiUrl.indexOf('https') < 0) {
        apiUrl = 'https://' + apiUrl;
    }
    const schema = joi.object({
        storage: joi.string().required(),
        isoFile: joi.string().required(),
        isoUrl: joi.string().uri().required()
    });
    const { error, value } = schema.validate(options);
    if (error) {
        throw new Error(`Invalid downloadIso options: ${error.message}`);
    }
    const {
        storage,
        isoFile,
        isoUrl
    } = value;

    // prepare headers/auth
    const instance = axios.create({ baseURL: apiUrl, timeout: 120000, validateStatus: s => s < 500 });
    let headers = {};

    headers.Authorization = `PVEAPIToken=${this.config.api_user}=${this.config.api_token}`;

    // attempt proxmox storage download API (may not be available on all versions)
    try {
        const dlParams = new URLSearchParams();
        let isoFileName = isoFile.split('/').pop();
        dlParams.append('url', isoUrl);
        dlParams.append('filename', isoFileName);
        dlParams.append('content', 'iso');
        const dlResp = await instance.post(
            `/api2/json/nodes/${encodeURIComponent(this.config.node)}/storage/${encodeURIComponent(storage)}/download-url`,
            dlParams.toString(),
            {
                httpsAgent,
                headers: Object.assign({}, headers, { 'Content-Type': 'application/x-www-form-urlencoded' }),
                timeout: 300000
            }
        );
        if (dlResp.status === 200 || dlResp.status === 201) {
            return true;
        }
        // If API returned something else, fall through to fallback
    } catch (err) {
        throw new Error(`Proxmox ISO download via API failed: ${err.message}`);
    }
};

Proxmox.prototype.getTemplateInfo = async function (templateName) {
    let apiUrl = this.config.endpoint;
    if (apiUrl.indexOf('https') < 0) {
        apiUrl = 'https://' + apiUrl;
    }
    const instance = axios.create({ baseURL: apiUrl, timeout: 120000, validateStatus: s => s < 500 });
    let headers = {};

    headers.Authorization = `PVEAPIToken=${this.config.api_user}=${this.config.api_token}`;

    // fetch template VM info
    try {
        const resp = await instance.get(
            `/api2/json/nodes/${encodeURIComponent(this.config.node)}/qemu`,
            { httpsAgent: new https.Agent({ rejectUnauthorized: false }), headers }
        );
        if (resp.status === 200 && Array.isArray(resp.data.data)) {
            const found = resp.data.data.find(item => {
                if (item?.name === templateName) {
                    return true;
                } else {
                    return false;
                }
            });
            if (found) {
                return found;
            } else {
                return null
            }
        } else {
            throw new Error(`Listing VMs failed with ${resp.status}: ${resp.data?.errors || 'unknown error'}`);
        }
    } catch (err) {
        throw new Error(`Failed to list VMs: ${err.message}`);
    }
};

Proxmox.prototype.deleteTemplate = async function (id) {
    let apiUrl = this.config.endpoint;
    if (apiUrl.indexOf('https') < 0) {
        apiUrl = 'https://' + apiUrl;
    }
    const instance = axios.create({ baseURL: apiUrl, timeout: 120000, validateStatus: s => s < 500 });
    let headers = {};

    headers.Authorization = `PVEAPIToken=${this.config.api_user}=${this.config.api_token}`;

    // delete template VM
    try {
        const resp = await instance.delete(
            `/api2/json/nodes/${encodeURIComponent(this.config.node)}/qemu/${encodeURIComponent(id)}`,
            { httpsAgent: new https.Agent({ rejectUnauthorized: false }), headers }
        );
        if (resp.status === 200 || resp.status === 202) {
            return true;
        } else {
            throw new Error(`Deleting VM failed with ${resp.status}: ${resp.data?.errors || 'unknown error'}`);
        }
    } catch (err) {
        throw new Error(`Failed to delete VM: ${err.message}`);
    }
};  

module.exports = Proxmox;