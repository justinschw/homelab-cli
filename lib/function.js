'use strict';
const fs = require('fs');
const joi = require('joi');
const net = require('net');
const Bw = require('./bw');

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
  const data = loadConfig(configFile);
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
    reserved: joi.object({
      vmids: joi.array().items(joi.object({
        vmid: joi.number().integer().required(),
        refId: joi.string().required()
      })).required(),
      ips: joi.array().items(joi.object({
        ip: joi.string().ip({ version: ['ipv4', 'ipv6'] }).required(),
        refId: joi.string().required()
      })).required(),
    }).required(),
    templates: joi.array().items(joi.object({
      name: joi.string().required(),
      version: joi.string().required(),
      vmid: joi.number().integer().required()
    })).required(),
    networks: joi.array().items(joi.object({
      name: joi.string().required(),
      subnet: joi.string().required(),
      gateway: joi.string().ip({ version: ['ipv4', 'ipv6'] }).required(),
      dns: joi.string().ip({ version: ['ipv4', 'ipv6'] }).required(),
      iface: joi.string().required(),
      dhcp_enabled: joi.boolean().required(),
      domain: joi.string().optional(),
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
  return value;
}

function getNextVmId(type, inventory) {
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

  let used = new Set();
  inventory.templates.forEach(t => {
    used.add(t.vmid);
  });
  inventory.reserved.vmids.forEach(v => {
    used.add(v.vmid);
  });

  for (let id = range[0]; id <= range[1]; id++) {
    if (!used.has(id)) return id;
  }

  throw new Error(`No available vmid for type ${type}`);
}

function getNextIpAddress(networkName, inventory) {
  if (!inventory) {
    throw new Error('Inventory not loaded');
  }

  const netCfg = (inventory.networks || []).find(n => n.name === networkName);
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

  // determine prefix length from network subnet (e.g. '10.88.1.0/24')
  let prefixLen = null;
  if (netCfg.subnet && typeof netCfg.subnet === 'string' && netCfg.subnet.includes('/')) {
    const parts = netCfg.subnet.split('/');
    if (parts.length === 2 && parts[1]) prefixLen = parts[1];
  }

  const used = new Set();
  // reserve gateway and dns
  if (netCfg.gateway) used.add(version === 4 ? ipv4ToBig(netCfg.gateway) : ipv6ToBig(netCfg.gateway));
  if (netCfg.dns) used.add(version === 4 ? ipv4ToBig(netCfg.dns) : ipv6ToBig(netCfg.dns));
  // gather host-assigned IPs for this network
  (inventory.hosts || []).forEach(h => {
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
      const ipStr = version === 4 ? bigToIpv4(ipBig) : bigToIpv6(ipBig);
      return prefixLen ? `${ipStr}/${prefixLen}` : ipStr;
    }
  }

  throw new Error(`No available static IP in range for network ${networkName}`);
}

function reserveVmId(type, inventory, refId) {
  if (!inventory.reserved) {
    inventory.reserved = { vmids: [], ips: [] };
  }
  // see if it's already present
  const existing = inventory.reserved.vmids.find(v => v.refId == refId);
  if (existing) {
    return existing.vmid;
  } else {
    const vmid = getNextVmId(type, inventory);
    inventory.reserved.vmids.push({ vmid, refId });
    return vmid;
  }
}

function releaseVmId(inventory, refId) {
  if (!inventory.reserved?.vmids || inventory.reserved.vmids.length === 0) {
    return;
  }
  const index = inventory.reserved.vmids.findIndex(v => v.refId == refId);
  let vmid = inventory.reserved.vmids[index].vmid;
  if (index !== -1) {
    inventory.reserved.vmids.splice(index, 1);
  }
  return vmid;
}

function reserveIpAddress(networkName, inventory, refId) {
  if (!inventory.reserved) {
    inventory.reserved = { vmids: [], ips: [] };
  }
  // see if it's already present
  const existing = inventory.reserved.ips.find(ip => ip.refId == refId);
  if (existing) {
    return existing.ip;
  } else {
    const ip = getNextIpAddress(networkName, inventory);
    inventory.reserved.ips.push({ ip, refId });
    return ip;
  }
}

function releaseIpAddress(inventory, refId) {
  if (!inventory.reserved) {
    return;
  }
  const index = inventory.reserved.ips.findIndex(ip => ip.refId == refId);
  let ip = inventory.reserved.ips[index].ip;
  if (index !== -1) {
    inventory.reserved.ips.splice(index, 1);
  }
  return ip;
}

// Parsing functions
function getRefValue(refString, obj) {
  const path = refString.split('.');
  let refValue = obj;
  for (const p of path) {
    if (Array.isArray(refValue)) {
      refValue = refValue.find(item => item.name === p);
    }
    else if (refValue && p in refValue) {
      refValue = refValue[p];
    } else {
      refValue = null;
      break;
    }
  }
  return refValue;
}

function populateBitwardenRefs(config, inventory, bwAuth) {
  return new Promise(async (resolve, reject) => {
    let bw;
    try {
      bw = new Bw(bwAuth);
      await bw.login();
      await bw.unlock();
      await bw.list();
      inventory = await bw.fill(inventory);
      config = await bw.fill(config);
      await bw.lock();
      await bw.logout();
      return resolve({ config, inventory });
    } catch (err) {
      if (bw) {
        try {
          await bw.lock();
          await bw.logout();
        } catch (e) {
          // ignore
        }
      }
      reject(err);
    }
  });
};

function populateInventoryRefs(config, inventory) {
  let strConfig = JSON.stringify(config)
  const inventoryRefRegex = /{inventory:([^"}]+)}/g;
  const inventoryMatches = Array.from(strConfig.matchAll(inventoryRefRegex), m => m[0]);
  for (let i = 0; i < inventoryMatches.length; i++) {
    const element = inventoryMatches[i].replace(/{|}/g, '');
    const result = getRefValue(element.slice('inventory:'.length), inventory);
    strConfig = strConfig.replace(inventoryMatches[i], result);
  }
  return JSON.parse(strConfig);
}

function populateUpperLevelRefs(config) {
  let strConfig = JSON.stringify(config);
  const upperLevelRegex = /{config:([^"}]+)}/g;
  const upperMatches = Array.from(strConfig.matchAll(upperLevelRegex), m => m[0]);
  for (let i = 0; i < upperMatches.length; i++) {
    const element = upperMatches[i].replace(/{|}/g, '');
    const result = getRefValue(element.slice('config:'.length), config);
    strConfig = strConfig.replace(upperMatches[i], result);
  }
  return JSON.parse(strConfig);
}

function updateInventory(inventoryFile, updatedInventory) {
  let inventory = loadInventory(inventoryFile);
  if (!inventory) {
    throw new Error('Failed to load inventory for update');
  }
  inventory.reserved = updatedInventory.reserved;

  fs.writeFileSync(inventoryFile, JSON.stringify(inventory, null, 2), 'utf8');
}

module.exports = {
      getNextVmId,
      getNextIpAddress,
      reserveVmId,
      releaseVmId,
      reserveIpAddress,
      releaseIpAddress,
      loadConfig,
      loadInventory,
      getRefValue,
      populateBitwardenRefs,
      populateInventoryRefs,
      populateUpperLevelRefs,
      updateInventory
    }
