'use strict';

const joi = require('joi');

function Ansible(config) {
    const schema = joi.object({
        playbook: joi.string().required(),
        inventoryFile: joi.string().required(),
        vars: joi.object().required(),
        ssh_key: joi.string().optional()
    });
    const { error, value } = schema.validate(config);
    if (error) {
        throw new Error(`Invalid Ansible config: ${error.message}`);
    }
    this.config = value;
}