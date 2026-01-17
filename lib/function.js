'use strict';
const { verify } = require('crypto');
const fs = require('fs');
const joi = require('joi');
const net = require('net');
const { version } = require('os');

let self = {};

function loadConfig(configFile) {
  // Load configuration settings
  try {
    const data = fs.readFileSync(configFile, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error loading config file: ${error.message}`);
    return null;
  }
}

function loadInventory(configFile) {
  const data = loadConfig(configFile);0
  const schema = joi.object({
    proxmox: joi.object({
      //host: joi.string().hostname().required(),
      username: joi.string().required(),
      password: joi.string().required(),
      endpoint: joi.string().required(),
      api_user: joi.string().required(),
      api_token: joi.string().required(),
      node: joi.string().required()
    }).required(),
    terraform: joi.object({
      backend: joi.object({
        type: joi.string().required(),
        config: joi.object().required()
      }).required()
    }).required(),
    hosts: joi.array().items(joi.object({
      name: joi.string().required(),
      vmid: joi.number().integer().required(),
      type: joi.string().valid('baremetal', 'vm', 'lxc').required(),
      interfaces: joi.array().items(joi.object({
        network: joi.string().required(),
        ip: joi.string().ip({ version: ['ipv4', 'ipv6'] }).required()
      }))
    })).required(),
    templates: joi.array().items(joi.object({
      name: joi.string().required(),
      version: joi.string().required(),
      vmid: joi.number().integer().required(),
      type: joi.string().valid('vm', 'lxc').required()
    })).required(),
    networks: joi.array().items(joi.object({
      name: joi.string().required(),
      subnet: joi.string().required(),
      gateway: joi.string().ip({ version: ['ipv4', 'ipv6'] }).required(),
      dns: joi.string().ip({ version: ['ipv4', 'ipv6'] }).required(),
      iface: joi.string().required(),
      dhcp_enabled: joi.boolean().required(),
      static_range: joi.object({
        start: joi.string().ip({ version: ['ipv4', 'ipv6'] }).required(),
        end: joi.string().ip({ version: ['ipv4', 'ipv6'] }).required(),
      }).required(),
    })).required(),
  });
  const { error, value } = schema.validate(data);
  if (error) {
    console.error(`Invalid inventory data: ${error.message}`);
    return null;
  }
  self.inventory = data;
  return data;
}

function getNextVmId(type) {
  if (typeof self === 'undefined' || !self.inventory) {
    throw new Error('Inventory not loaded');
  }

  const ranges = {
    baremetal: [0, 99],
    vm: [100, 199],
    lxc: [200, 299],
    template: [300, 399]
  };

  const range = ranges[type];
  if (!range) {
    throw new Error(`Unknown type: ${type}`);
  }

  const used = new Set(
    (self.inventory.hosts || [])
    .map(h => h.vmid)
    .filter(Number.isInteger)
  );

  for (let id = range[0]; id <= range[1]; id++) {
    if (!used.has(id)) return id;
  }

  throw new Error(`No available vmid for type ${type}`);
}

function getNextIpAddress(networkName) {
    if (typeof self === 'undefined' || !self.inventory) {
      throw new Error('Inventory not loaded');
    }
    if (typeof self === 'undefined' || !self.inventory) {
      throw new Error('Inventory not loaded');
    }

    const netCfg = (self.inventory.networks || []).find(n => n.name === networkName);
    if (!netCfg) throw new Error(`Network not found: ${networkName}`);

    const startIp = netCfg.static_range && netCfg.static_range.start;
    const endIp = netCfg.static_range && netCfg.static_range.end;
    if (!startIp || !endIp) throw new Error(`Invalid static_range for network ${networkName}`);

    const version = net.isIP(startIp);
    if (version === 0 || version !== net.isIP(endIp)) throw new Error('Start and end IP must be valid and same IP version');

    function ipv4ToBig(ip) {
      return BigInt(ip.split('.').reduce((acc, octet) => (acc << 8n) + BigInt(parseInt(octet, 10)), 0n));
    }
    function bigToIpv4(n) {
      return [
        Number((n >> 24n) & 0xFFn),
        Number((n >> 16n) & 0xFFn),
        Number((n >> 8n) & 0xFFn),
        Number(n & 0xFFn)
      ].join('.');
    }
    function expandIpv6(ip) {
      if (ip.includes('::')) {
        const [left, right] = ip.split('::');
        const l = left ? left.split(':').filter(Boolean) : [];
        const r = right ? right.split(':').filter(Boolean) : [];
        const zeros = 8 - (l.length + r.length);
        const parts = [...l, ...Array(zeros).fill('0'), ...r];
        return parts.map(p => p || '0');
      }
      return ip.split(':').map(p => p || '0');
    }
    function ipv6ToBig(ip) {
      const parts = expandIpv6(ip).map(p => parseInt(p, 16));
      return parts.reduce((acc, part) => (acc << 16n) + BigInt(part), 0n);
    }
    function bigToIpv6(n) {
      const parts = [];
      for (let i = 0; i < 8; i++) {
        parts.unshift(Number(n & 0xFFFFn).toString(16));
        n = n >> 16n;
      }
      return parts.join(':').replace(/\b:?(?:0+:){2,}0+\b/, m => m); // no aggressive compression needed
    }

    const startBig = version === 4 ? ipv4ToBig(startIp) : ipv6ToBig(startIp);
    const endBig = version === 4 ? ipv4ToBig(endIp) : ipv6ToBig(endIp);
    if (startBig > endBig) throw new Error('static_range start is greater than end');

    const used = new Set();
    // reserve gateway and dns
    if (netCfg.gateway) used.add(version === 4 ? ipv4ToBig(netCfg.gateway) : ipv6ToBig(netCfg.gateway));
    if (netCfg.dns) used.add(version === 4 ? ipv4ToBig(netCfg.dns) : ipv6ToBig(netCfg.dns));
    // gather host-assigned IPs for this network
    (self.inventory.hosts || []).forEach(h => {
      (h.interfaces || []).forEach(iface => {
        if (iface.network === networkName && iface.ip && net.isIP(iface.ip)) {
          const b = version === 4 ? ipv4ToBig(iface.ip) : ipv6ToBig(iface.ip);
          used.add(b);
        }
      });
    });

    // find lowest available IP in range
    for (let ipBig = startBig; ipBig <= endBig; ipBig++) {
      if (!used.has(ipBig)) {
        return version === 4 ? bigToIpv4(ipBig) : bigToIpv6(ipBig);
      }
    }

    throw new Error(`No available static IP in range for network ${networkName}`);
}

module.exports = {
  self,
  getNextVmId,
  getNextIpAddress,
  loadConfig,
  loadInventory
}
