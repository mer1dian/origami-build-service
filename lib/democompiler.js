'use strict';

const Q = require('./utils/q');
const pfs = require('q-io/fs');
const log = require('./utils/log');
const FileProxy = require('./fileproxy');

const streamCat = require('streamcat');
const gulp = require('gulp');
const obt = require('origami-build-tools');
const CompileError = require('./utils/compileerror');

function DemoCompiler() {
	this.fileProxy = new FileProxy();
};

DemoCompiler.prototype = {

	getContent: Q.async(function*(installation, moduleset, options) {
		const installedModules = yield installation.list(moduleset);
		options.moduleName = Object.keys(installedModules)[0];
		options.moduleVersion = installedModules[options.moduleName].version;
		// Checks if it's the old demo config format where demos have
		// a path to the html file of the already compiled demo
		// If so, serve it via the file proxy, otherwise, compile it
		const origamiManifest = yield installation.getOrigamiManifest(options.moduleName);
		// As the demos parameter can be either an object (old config spec)
		// or an array, we just get the first key using Object.keys
		if (origamiManifest && origamiManifest.demos && origamiManifest.demos[Object.keys(origamiManifest.demos)[0]].path) {
			const demoRelativePath = 'demos/' + options.demoName + '.html';
			const demoAbsolutePath = installation.getPathToComponentsFile(options.moduleName, demoRelativePath);

			const versionLockedContent = new Buffer(this.fileProxy.versionLockBuildserviceUrls(yield pfs.read(demoAbsolutePath), options.moduleName, options.moduleVersion, 'http://build.origami.ft.com' + options.reqUrl));
			return versionLockedContent;
		} else {
			const demoBuildPromise = this._doBuild(installation, moduleset, options);
			// Concatenate buffers and streams in order asynchronously, returns a
			// ReadStream with the concatenated content
			return streamCat([
				demoBuildPromise
			], {
				errorMapper: function(error) {
					return installation.sanitizeError(error);
				}
			});
		}
	}),

	_doBuild: function(installation, moduleset, options) {
		return new Promise((resolve, reject) => {
			const demoConfig = {
				dist: true,
				demoFilter: options.demoName,
				cwd: installation.getComponentDir(options.moduleName)
			};

			log.trace(demoConfig, 'Starting OBT Demo build');
			const demoStream = obt.demo(gulp, demoConfig);

			const filesGenerated = [];

			demoStream.on('data', function(file) {
				log.trace('OBT demo compiling');
				filesGenerated.push(file);
			});

			demoStream.on('end', () => {
				if (filesGenerated.length > 0) {
					log.debug(demoConfig, 'OBT Demo build complete');
					const html = filesGenerated[0].contents.toString('utf8');
					const versionLockedContent = this.fileProxy.versionLockBuildserviceUrls(html, options.moduleName, options.moduleVersion, 'http://build.origami.ft.com' + options.reqUrl);
					resolve(new Buffer(versionLockedContent));
				} else {
					reject(new CompileError('No file were generated running obt.demo'));
				}
			});

			demoStream.on('error', function(err) {
				reject(new CompileError(err.message));
			});
		});
	}
};

module.exports = DemoCompiler;