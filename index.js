#!/usr/bin/env node --harmony
'use strict';

require('es6-shim');

const createApp = require('./lib/index');
const log = require('./lib/utils/log');
const BuildSystem = require('./lib/buildsystem');
const program = require('commander');
const package_json = require('./package.json');
const HealthMonitor = require('./lib/monitoring/healthmonitor');
const Registry = require('./lib/registry');
const diskCacheCleaner = require('./tools/diskcacheclean');
const os = require('os');
const URL = require('url');
const fs = require('fs');
const path = require('path');
const mkdirp = require('mkdirp');
const uidNumber = require('uid-number');

const myParseInt = function(val){return parseInt(val, 10);};

program
	.version(package_json.version)
	.option('-p, --port <num>', 'Port number to listen on', myParseInt, process.env.PORT || 9000)
	.option('--export <name>', 'Default bundle export name', 'Origami')
	.option('--uid <num>', 'User ID to run as')
	.option('--gid <num>', 'Group ID to run as')
	.parse(process.argv);

const tempdir = '/tmp/buildservice-' + process.pid + '/';
process.env.HOME = tempdir; // Workaround: Bower ends up using $HOME/.local/share/bower/empty despite config overriding this

const dirInitialised = (function initialiseCacheDirectory(tempDirectory) {

	function mkdirpp(dir) {
		return new Promise(function(resolve, reject) {
			mkdirp(dir, function(e) {
				if (e) { reject(e); } else { resolve(); }
			});
		});
	}

	return mkdirpp(tempDirectory).then(new Promise(function() {

		const filePath = path.join(tempDirectory, '/.netrc');
		const netrc = 'machine github.com\nlogin ' + process.env.GITHUB_USERNAME + '\npassword ' + process.env.GITHUB_PASSWORD;

		return new Promise(function(resolve, reject) {
			fs.writeFile(filePath, netrc, function(e) {
				if (e) {
					reject(e);
				} else {
					resolve();
				}
			});
		});
	})).then(function() {
		return new Promise(function(resolve, reject) {
			if (!program.uid) {
				resolve();
				return;
			}

			uidNumber(program.uid, program.gid, function(er, uid, gid) {
				if (er) {
					reject(er);
					return;
				}
				fs.chown(tempDirectory, uid, gid, function(e) {
					if (e) {
						reject(e);
					} else {
						resolve();
					}
				});
			});
		});
	});
}(tempdir));

const registry = new Registry();
const healthMonitor = new HealthMonitor({log:log});
const buildSystem = new BuildSystem({
	log: log,
	port: program.port,
	export: program.export,
	tempdir: tempdir,
	registry: registry,
	uid: program.uid,
	gid: program.gid,

	installationTtl: 24*3600*1000,
	installationTtlExact: 3*24*3600*1000,
	httpProxyTtl: 12*3600*1000,
});


(function() {
	const hostname = os.hostname();

	function tcpCheckInstruction(to, port) {
		return 'Check TCP connectivity between `' + hostname +
			'` and `github.com:80`. Try: `ssh ' + hostname +
			' nc -w 5 -z ' + to + ' ' + port +
			'`.  If successful, the output of the command should include something similar to: `Connection to ' + to + ' port ' + port + ' [tcp/*] succeeded!`.';
	}

	healthMonitor.addSystemLoadCheck({
		name: 'System load',
		checkPeriod: 10, // five minutes
		severity: 1,
		businessImpact: 'As more requests are serviced by this node, responses will become slower until they time out, styles and functionality on dependent sites may be affected.  Expect end user reports from critical sites if left unfixed.',
		panicGuide: 'If access to the virtual machine is possible, immediately attempt to restart the service using: `sudo service buildservice restart`, if access is not possible, via the InfraProd AWS Console, reboot `' + hostname + '`. Finally ensure other healthchecks are ok as failing conditions may cause load averages to increase.'
	});

	healthMonitor.addTcpIpCheck({
		name: 'Availability of Github (TCP/IP connectivity to github.com on port 80)',
		severity: 2,
		technicalSummary: 'This will prevent new modules from installing and being built where the module is stored on github.com.  If this continues to fail for large periods of time, expect end user reports from critical sites if left unfixed.',
		panicGuide: tcpCheckInstruction('github.com', 80) + ' If this fails, check whether `github.com` loads in a web browser and `https://status.github.com/` for reported downtime, if either of these steps are successful, however the check using `ssh` and `nc` above fails, escalate to the networks team.',
		checkPeriod: 30
	}, 'github.com', 80);

	healthMonitor.addTcpIpCheck({
		name: 'Availability of Github (TCP/IP connectivity to github.com on port 443)',
		severity: 2,
		technicalSummary: 'This will prevent new modules from installing and being built where the module is stored on github.com.  If this continues to fail for large periods of time, expect end user reports from critical sites if left unfixed.',
		panicGuide: tcpCheckInstruction('github.com', 443) + ' If this fails, check whether `github.com` loads in a web browser and `https://status.github.com/` for reported downtime, if either of these steps are successful, however the check using `ssh` and `nc` above fails, escalate to the networks team.',
		checkPeriod: 30
	}, 'github.com', 443);


	healthMonitor.addTcpIpCheck({
		name: 'Availability of registry.origami.ft.com (TCP/IP connectivity to registry.origami.ft.com on port 80)',
		severity: 2,
		technicalSummary: 'This will prevent any new modules from installing and being built.  If this continues to fail for large periods of time, expect end user reports from critical sites if left unfixed.',
		panicGuide: tcpCheckInstruction('registry.origami.ft.com', 80) + ' If this fails, check whether `registry.origami.ft.com` loads in a web browser, if this is unsuccessful refer to registry.origami.ft.com/__health. This may coincide with issues on FT Labs\' `prod01` infrastructure, if there are no known issues on `prod01`, yet this issue persists, escalate to the networks team.',
		checkPeriod: 30
	}, 'registry.origami.ft.com', 80);

	healthMonitor.addMemoryChecks({
		severity: 1,
		checkPeriod: 120,
		technicalSummary: 'Process has run out of available memory',
		panicGuide: 'Restart the service on `' + hostname + '`, Try: `ssh ' + hostname + '`, then `sudo service buildservice restart` and re-check health status for `' + hostname + ':8080/__health`'
	});

	dirInitialised.then(function() {
		healthMonitor.addDiskChecks({
			severity: 1,
			checkPeriod: 120,
			technicalSummary: '/tmp directory is full, new modules will not be installable.',
			panicGuide: 'Restart the service on `' + hostname + '`, Try: `ssh ' + hostname + '`, then `sudo service buildservice restart` and re-check health status for `' + hostname + ':8080/__health`',
			businessImpact: 'New modules will not be able to install and existing modules will not refresh.  As problem persists expect end user reports from critical sites regarding styling and broken functionality.'
		}, tempdir);
	});

	const seenPackageHosts = {};
	healthMonitor.addCheck({
		name: 'Listing all packages at registry.origami.ft.com',
		severity: 2,
		businessImpact: 'Static files won\'t be served. Healthcheck may be incomplete',
		panicGuide: 'Ensure registry.origami.ft.com/packages returns 200 and is valid JSON.',
		checkPeriod: 60,
	}, function(){
		return registry.refreshPackageList().then(function(packageList){
			const checksToAdd = [];
			for(let i=0; i < packageList.length; i++) {
				const p = packageList[i];
				const url = URL.parse(p.url, false, true);

				if (!url.host) continue;

				if (!seenPackageHosts[url.host]) {  // url.host contains the port as well
					seenPackageHosts[url.host] = {url:url, packageNames:[]};
					checksToAdd.push(seenPackageHosts[url.host]);
				}
				if (seenPackageHosts[url.host].packageNames.length < 25) {
					seenPackageHosts[url.host].packageNames.push(p.name);
				}
				else if (seenPackageHosts[url.host].packageNames.length === 25) {
					seenPackageHosts[url.host].packageNames.push('and more…');
				}
			}

			for(let i=0; i < checksToAdd.length; i++) {
				const host = checksToAdd[i];

				let hostName = host.url.host;
				let port = 80;
				if (host.url.host.contains(':')) {
					const splitUrl = host.url.host.split(':');
					hostName = splitUrl[0];
					port = splitUrl[1];
				}

				healthMonitor.addTcpIpCheck({
					name: 'Availability of package server ' + host.url.host + ' (TCP/IP)',
					severity: 2,
					businessImpact: 'It won\'t be possible to install or refresh these packages: ' + host.packageNames.join(', '),
					panicGuide: 'Ensure TCP/IP connections to ' + host.url.host + ' work from ' + os.hostname() + '.  Try commands: `ssh ' + os.hostname() + '`, then `nc -w 5 -z ' + hostName + ' ' + port + '`.  If the output of the `nc` command is successful it will output something like: `Connection to ' + host.url.host + ' port ' + port + ' [tcp/*] succeeded!`, if this is unsuccessful the output will be blank after approximately 5 seconds. Escalate to the Networks team.',
					checkPeriod: 60,
				}, host.url.hostname, host.url.port || 80);
			}
		});
	});
}());

const app = createApp({
	buildSystem: buildSystem,
	healthMonitor: healthMonitor,
	writeAccessLog: true
});

app.listen(program.port, function() {
	log.info({port: program.port, env:process.env.NODE_ENV}, 'Started server');
	dirInitialised.then(function() {
		dropPrivileges({ uid: program.uid, gid: program.gid });
	});
	diskCacheCleaner();
});


function dropPrivileges(options) {
	if (options.uid || options.gid) {
		process.setgroups([]);
		process.setgid(options.gid || options.uid);

		if (options.uid) {
			process.setuid(options.uid);
			process.env.USER = options.uid; // Bower assumes process.env.USER matches privileges of current user
		}
	}

	log.info({uid:process.getuid(), gid:process.getgid()}, 'Set process owner');

	process.umask(parseInt('0022',8)); // u+rwx, go+rx
}