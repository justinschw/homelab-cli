'use strict';

const Executor = require('./executor');
const joi = require('joi');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  loadInventory,
  populateInventoryRefs,
  populateUpperLevelRefs,
  populateBitwardenRefs,
  getNextVmId,
  getNextIpAddress,
  updateInventoryWithNewEntries
} = require('./function');

function Terraform(config) {
  const schema = joi.object({
    module: joi.string().required(),
    branch: joi.string().default('master'),
    path: joi.string().optional(),
    type: joi.string().valid('vm', 'lxc').default('vm'),
    inventoryFile: joi.string().required(),
    variables: joi.object().default({})
  });
  const { error, value } = schema.validate(config);
  if (error) {
    throw new Error(`Invalid Terraform config: ${error.message}`);
  }
  this.config = value;
  this.command = new Executor();
  this.newInventory = {
    vmids: [],
    ips: []
  };
  this.deletedInventory = {
    vmids: [],
    ips: []
  };
};

Terraform.prototype.populateVmIds = function (strConfig, destroy = false) {
  console.info('Populating VM IDs...');
  const vmIdRegex = /"(vm|lxc):id:[^":\s]+"/g;
  const vmIdMatches = new Set(Array.from(strConfig.matchAll(vmIdRegex), m => m[0]));
  const vmIds = [];
  const matchesArray = Array.from(vmIdMatches);
  for (let i = 0; i < matchesArray.length; i++) {
    const originalMatch = matchesArray[i];
    let element = originalMatch.replace(/"/g, '');
    const existing = this.inventory.reserved.vmids.find(v => v.refId == element);
    if (existing) {
      strConfig = strConfig.replace(element, existing.vmid);
      vmIds.push(existing.vmid);
      if (destroy) {
        this.deletedInventory.vmids.push(existing);
      }
    } else {
      const type = element.split(':')[0];
      const vmId = getNextVmId(type, this.inventory);
      strConfig = strConfig.replace(element, vmId);
      vmIds.push(vmId);
      this.newInventory.vmids.push({
        refId: element,
        vmid: vmId
      });
    }
  }
  return { strConfig, vmIds };
};

Terraform.prototype.populateIpAddresses = function (strConfig, destroy = false) {
  console.info('Populating IP addresses...');
  const ipRegex = /"ip:[^":\s]+:[^":\s]+"/g;
  const ipMatches = new Set(Array.from(strConfig.matchAll(ipRegex), m => m[0]));
  const reservedIps = [];
  const matchesArray = Array.from(ipMatches);
  for (let i = 0; i < matchesArray.length; i++) {
    const originalMatch = matchesArray[i];
    let element = originalMatch.replace(/"/g, '');
    const existing = this.inventory.reserved.ips.find(ip => ip.refId == element);
    if (existing) {
      strConfig = strConfig.replace(element, existing.ip);
      reservedIps.push(existing.ip);
      if (destroy) {
        this.deletedInventory.ips.push(existing);
      }
    } else {
      const parts = element.split(':');
      const networkName = parts[1];
      const ip = getNextIpAddress(networkName, this.inventory);
      strConfig = strConfig.replace(element, ip);
      reservedIps.push(ip);
      this.newInventory.ips.push({
        refId: element,
        ip: ip
      });
    }
  }
  return { strConfig, reservedIps };
};

Terraform.prototype.init = async function (destroy = false) {
  // Load the inventory file
  this.inventory = loadInventory(this.config.inventoryFile);
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
  console.info('Resolving inventory references in terraform config...');
  this.config = populateInventoryRefs(this.config, this.inventory);

  console.info('Resolving upper level references in terraform config...');
  this.config = populateUpperLevelRefs(this.config);

  let strConfig = JSON.stringify(this.config, null, 2);
  const vmResult = this.populateVmIds(strConfig, destroy);
  strConfig = vmResult.strConfig;
  console.info(`Using VM IDs: ${vmResult.vmIds.join(', ')}`);

  const ipResult = this.populateIpAddresses(strConfig, destroy);
  strConfig = ipResult.strConfig;
  console.info(`Reserving IP addresses: ${ipResult.reservedIps.join(', ')}`);
  this.config = JSON.parse(strConfig);

  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hlcli-tf-'));
  console.info(`Cloning Terraform module ${this.config.module} into ${tmpdir}...`);
  const cloneArgs = ['clone', this.config.module, '-b', this.config.branch, tmpdir];
  await this.command.run('git', cloneArgs, { log: false });
  this.clonedDir = tmpdir;
  this.moduleDir = path.resolve(tmpdir, this.config.path || '.');
};

Terraform.prototype.setBackendVars = function (args) {
  Object.keys(this.inventory.terraform.backend.config).forEach(key => {
    let value = this.inventory.terraform.backend.config[key];
    if (typeof value !== 'string') {
      value = JSON.stringify(value);
    }
    args.push(`-backend-config=${key}=${value}`);
  });
  // set key
  args.push(`-backend-config=key=${this.config.variables.server_name}-${this.config.variables.vm_id}.tfstate`);
}

Terraform.prototype.setVariables = function (env) {
  for (const [key, value] of Object.entries(this.config.variables)) {
    const val = (typeof value === 'string') ? value : JSON.stringify(value);
    env[`TF_VAR_${key}`] = val;
  }
};

Terraform.prototype.plan = async function (destroy = false, log = true) {

  const env = {
    ...process.env
  };
  this.setVariables(env);

  const initArgs = ['-chdir=' + this.moduleDir, 'init'];
  this.setBackendVars(initArgs);
  await this.command.run('terraform', initArgs, env, true);
  const planArgs = ['-chdir=' + this.moduleDir, 'plan'];
  this.planFile = path.join(this.moduleDir, `hlcli-tfplan-${Date.now()}`);
  planArgs.push('-out=' + this.planFile);
  if (destroy) {
    planArgs.push('-destroy');
  }
  await this.command.run('terraform', planArgs, env, true);
};

Terraform.prototype.apply = async function (log = true) {

  const env = {
    ...process.env
  };
  this.setVariables(env);
  const applyArgs = ['-chdir=' + this.moduleDir, 'apply', '-auto-approve'];
  //this.setBackendVars(planArgs);
  if (this.planFile) {
    applyArgs.push(this.planFile);
  }

  await this.command.run('terraform', applyArgs, env, true);
  // Add to inventory
  updateInventoryWithNewEntries(this.config.inventoryFile, this.newInventory, this.deletedInventory);
};

Terraform.prototype.cleanup = async function () {
  this.command.run('rm', ['-rf', this.clonedDir], { log: false });
};

module.exports = Terraform;
