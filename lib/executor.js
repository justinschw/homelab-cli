'use strict';
const {spawn} = require('child_process');
const joi = require('joi');

function Executor(config) {
    const schema = joi.object({
        execution: joi.string().valid('local', 'ssh').default('local'),
        ssh: joi.object({
            host: joi.string().when('..execution', { is: 'ssh', then: joi.required() }),
            port: joi.number().default(22),
            username: joi.string().when('..execution', { is: 'ssh', then: joi.required() }),
            privateKey: joi.string().optional()
        }).optional()
    });
    const { error, value } = schema.validate(config);
    if (error) {
        throw new Error(`Invalid Executor config: ${error.message}`);
    }
    this.config = value;
}

Executor.prototype.run = async function(command, args, env = {}, print = false) {
    return new Promise((resolve, reject) => {
        let finalCommand = command;
        let finalArgs = args;
        let spawnOptions = { stdio: ['ignore', 'pipe', 'pipe'] , env };

        if (this.config.execution === 'ssh') {
            finalArgs = [finalCommand, ...finalArgs];
            finalCommand = 'ssh';
            const sshEnv = [];
            if (Object.keys(env).length > 0) {
                sshEnv.push('-o', 'SendEnv ' + Object.keys(env).join(' '));
            }
            sshEnv.push('-o', 'ServerAliveInterval 60');
            if (sshEnv.length > 0) {
                finalArgs = [...sshEnv, ...finalArgs];
            }
            if (this.config.ssh.privateKey) {
                finalArgs = ['-i', this.config.ssh.privateKey, '-p', this.config.ssh.port.toString(), `${this.config.ssh.username}@${this.config.ssh.host}`, ...finalArgs];
            } else {
                finalArgs = ['-p', this.config.ssh.port.toString(), `${this.config.ssh.username}@${this.config.ssh.host}`, ...finalArgs];
            }
        }

        const child = spawn(finalCommand, finalArgs, spawnOptions);
        let output = '';
        let errorOutput = '';

        child.stdout.on('data', (data) => {
            output += data.toString();
            if (print) {
                process.stdout.write(data);
            }
        });
        child.stderr.on('data', (data) => {
            errorOutput += data.toString();
            if (print) {
                process.stderr.write(data);
            }
        });
        child.on('close', (code) => {
            if (code === 0) {
                resolve(output.trim());
            } else {
                reject(new Error(`Command failed with code ${code}: ${errorOutput.trim()}`));
            }
        });
    });
}

module.exports = Executor;