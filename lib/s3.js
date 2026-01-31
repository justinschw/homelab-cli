'use strict';

const joi = require('joi');
const fs = require('fs');
const https = require('https');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

function S3(config) {
    const schema = joi.object({
        endpoint: joi.string().required(),
        access_key: joi.string().required(),
        secret_key: joi.string().required(),
        bucket: joi.string().required(),
        region: joi.string().required()
    }).optional();
    const { error, value } = schema.validate(config);
    if (error) {
        throw new Error(`Invalid S3 config: ${error.message}`);
    }
    this.config = value;
}

S3.prototype.getS3File = async function (sourcePath, destPath) {
    const client = new S3Client({
        endpoint: `https://${this.config.endpoint}`,
        region: this.config.region,
        credentials: {
            accessKeyId: this.config.access_key,
            secretAccessKey: this.config.secret_key
        },
        forcePathStyle: true,
        tls: true,
        requestHandler: new (require('@aws-sdk/node-http-handler').NodeHttpHandler)({
            httpsAgent: new https.Agent({ rejectUnauthorized: false, keepAlive: false })
        })
    });
    const bucket = this.config.bucket;
    const key = sourcePath.startsWith('/') ? sourcePath.slice(1) : sourcePath;
    const getObjectParams = {
        Bucket: bucket,
        Key: key
    };
    const command = new GetObjectCommand(getObjectParams);
    const response = await client.send(command);
    await new Promise((resolve, reject) => {
        const writeStream = fs.createWriteStream(destPath);
        response.Body.pipe(writeStream);
        response.Body.on('error', (err) => {
            reject(err);
        });
        writeStream.on('finish', () => {
            resolve();
        });
    });
}

module.exports = S3;