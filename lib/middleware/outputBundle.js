'use strict';

const querystring = require('querystring');
const ModuleSet = require('../moduleset');
const stringToBoolean = require('../utils/string-to-boolean');
const cacheControlHeaderFromExpiry = require('../utils/cacheControlHeaderFromExpiry');
const metrics = require('../monitoring/metrics');
const CompileError = require('../utils/compileerror');
const path = require('path');
const InstallationManager = require('../installationmanager');
const Bundler = require('../bundler');

module.exports = config => {
	const timeoutDurationMSec = 20000;
	const maxBuildTimeMSec = 60000;

	const bundler = new Bundler();
	const installationManager = new InstallationManager({
		temporaryDirectory: config.tempdir
	});

	function getBundleDetails(req) {
		const modules = req.query.modules.split(/\s*,\s*/);

		// Developer may either set autoinit query param or might add o-autoinit to their module list
		const autoinitIncluded = modules.some(module => module.startsWith('o-autoinit'));

		if (req.query['autoinit'] !== '0' && !autoinitIncluded) {
			modules.push('o-autoinit@^1.0.0');
		}

		return {
			babelRuntime: req.query.polyfills ? stringToBoolean(req.query.polyfills) : true,
			newerThan: req.query.newerthan ? Date.parse(req.query.newerthan) : false,
			modules: new ModuleSet(modules),
			versionLocks: req.query.shrinkwrap ? new ModuleSet(req.query.shrinkwrap.split(/\s*,\s*/)) : false,
			minify: !(req.query.minify && req.query.minify === 'none'),
			exportName: (req.query['export'] === undefined) ? 'Origami' : req.query['export']
		};
	}

	function promiseTimeout(duration) {
		return new Promise(function (resolve, reject) {
			setTimeout(reject, duration, 'timeout');
		});
	}

	return function outputBundle(req, res, next) {
		const type = req.params[0];
		const bundleDetails = getBundleDetails(req);
		const moduleset = bundleDetails.modules;
		const moduleInstallationPromise = installationManager.createInstallation(moduleset, bundleDetails);
		// If bundle takes a long time to generate, issue a redirect response to reconnect -
		// this avoids short request timeouts in Heroku and other possible intermediary nodes.
		// Also when running multiple build service nodes, this provides an opportunity to
		// connect to a different backend that may already have the bundle in cache
		return Promise.race([
			bundler.getBundle(type, moduleInstallationPromise, moduleset, bundleDetails),
			promiseTimeout(timeoutDurationMSec)
		]).then(function (bundle) {

			// If request went via any redirects, redirect one final time to the canonical URL to enable response to be cached efficiently and avoid caching URLs containing `redirects` args
			if (req.query.redirects) {
				delete req.query.redirects;
				metrics.counter('routes.bundle.redirect').inc();
				res.redirect(307, selfURL(req));
			} else {
				res.set({
					'Content-Type': bundle.mimeType,
					'Last-Modified': new Date(bundle.createdTime).toUTCString(),
					'Cache-Control': cacheControlHeaderFromExpiry(bundle.expiryTime)
				});

				if (req.query.shrinkwrap) {
					metrics.counter('routes.bundle.serveShrinkWrapped').inc();
				}
				metrics.counter('routes.bundle.serve').inc();
				bundle.pipe(res).end();
			}
			next(); // AB: Why are we calling next() here?
		}).catch(function (error) {
			if (error === 'timeout') {
				req.query.redirects = parseInt(req.query.redirects || 0, 10) + 1;
				if ((req.query.redirects * timeoutDurationMSec) > maxBuildTimeMSec) {
					metrics.counter('routes.bundle.timeout').inc();
					next(new CompileError('Maximum allowable build time exceeded'));
				} else {
					res.redirect(307, selfURL(req));
				}
			} else {
				// Pass on any real errors so Express can convert them into an appropriate HTTP response
				metrics.counter('routes.bundle.error').inc();
				next(error);
			}
		});
	};

	function selfURL(req) {
		const qs = querystring.stringify(req.query);
		return path.join(req.basePath, req.path) + (qs ? '?' + qs : '');
	}
};