'use strict';

const assert = require('chai').assert;
const mockery = require('mockery');
const sinon = require('sinon');

describe('lib/middleware/outputBundle', function() {
	let bundler;
	let cacheControlHeaderFromExpiry;
	let CompileError;
	let installationmanager;
	let metrics;
	let ModuleSet;
	let outputBundle;

	beforeEach(() => {
		bundler = require('../../mock/bundler.mock');
		mockery.registerMock('../bundler', bundler);

		cacheControlHeaderFromExpiry = require('../../mock/cacheControlHeaderFromExpiry.mock');
		mockery.registerMock('../utils/cacheControlHeaderFromExpiry', cacheControlHeaderFromExpiry);

		CompileError = require('../../mock/compileerror.mock');
		mockery.registerMock('../utils/compileerror', CompileError);

		installationmanager = require('../../mock/installationmanager.mock');
		mockery.registerMock('../installationmanager', installationmanager);

		metrics = require('../../mock/metrics.mock');
		mockery.registerMock('../monitoring/metrics', metrics);

		ModuleSet = require('../../mock/moduleset.mock');
		mockery.registerMock('../moduleset', ModuleSet);

		outputBundle = require('../../../../lib/middleware/outputBundle');
	});

	it('exports a function', () => {
		assert.isFunction(outputBundle);
	});

	describe('outputBundle(config)', () => {
		let config;
		let middleware;

		beforeEach(() => {
			config = {
				tempdir: '/tmp'
			};
			middleware = outputBundle(config);
		});

		it('returns a middleware function', () => {
			assert.isFunction(middleware);
		});

		describe('middleware(request, response, next)', () => {
			let next;
			let response;
			let request;

			beforeEach(() => {

				next = sinon.spy();
				response = require('../../mock/express.mock').mockResponse;
				request = require('../../mock/express.mock').mockRequest;
				request.query.modules = 'test';
			});

			describe('errors', function () {
				this.timeout(30 * 1000);

				beforeEach(() => {
					bundler.getBundle.resolves(new Promise(resolve =>
						setTimeout(resolve, 22 * 1000)
					));
				});

				describe('when bundle takes more than 20 seconds', () => {
					it('returns a 307, redirecting to itself', () => {
						bundler.getBundle.resolves(new Promise(resolve =>
							setTimeout(resolve, 22 * 1000)
						));

						return middleware(request, response, next)
						.then(() => {
							assert.calledOnce(response.redirect);
							assert.equal(request.query.redirects, 1);
							assert.calledWithExactly(response.redirect, 307, '/?modules=test&redirects=1');
						});
					});
				});

				describe('when a redirected bundle takes more than 20 seconds', () => {
					it('returns a 307, redirecting to itself', () => {
						request.query.redirects = 1;

						return middleware(request, response, next)
						.then(() => {
							assert.calledOnce(response.redirect);
							assert.equal(request.query.redirects, 2);
							assert.calledWithExactly(response.redirect, 307, '/?modules=test&redirects=2');
						});
					});
				});

				describe('when a second-time redirected bundle takes more than 20 seconds', () => {
					it('returns a 307, redirecting to itself', () => {
						request.query.redirects = 2;

						return middleware(request, response, next)
						.then(() => {
							assert.calledOnce(response.redirect);
							assert.equal(request.query.redirects, 3);
							assert.calledWithExactly(response.redirect, 307, '/?modules=test&redirects=3');
						});
					});
				});

				describe('when a third-time redirected bundle takes more than 20 seconds', () => {
					it('returns a Compile Error', () => {
						request.query.redirects = 3;
						return middleware(request, response, next)
						.then(() => {
							assert.calledOnce(next);
							assert.calledWithExactly(next, CompileError.mockInstance);
						});
					});
				});

				describe('when a bundle has an error', () => {
					let error;

					beforeEach(() => {
						error = new Error();
						bundler.getBundle.rejects(error);
					});

					it('passes the error into `next`', () => {
						return middleware(request, response, next)
						.then(() => {
							assert.calledOnce(next);
							assert.calledWithExactly(next, error);
						});
					});
				});
			});

			describe('builds', () => {
				describe('if build has a redirect query parameter', () => {
					beforeEach(() => {
						bundler.getBundle.resolves();
					});

					it('redirects to same URL without the redirect paramater', () => {
						request.query.redirects = 1;

						return middleware(request, response, next)
						.then(() => {
							assert.calledOnce(response.redirect);
							assert.calledWithExactly(response.redirect, 307, '/?modules=test');
						});
					});
				});

				describe('returning built demo', () => {
					let bundle;

					beforeEach(() => {
						bundle = {
							mimeType: 'text/html',
							createdTime: new Date(),
							expiryTime: Date.now() + 10000
						};
						bundler.getBundle.resolves(bundle);
						cacheControlHeaderFromExpiry.returnsArg(0);
					});

					it('uses files mimetype as the content-type of the response', () => {
						return middleware(request, response, next)
							.then(() => {
								assert.equal(response.set.firstCall.args[0]['Content-Type'], bundle.mimeType);
							});
					});

					it('uses files createdTime as the last-modified time of the response', () => {
						return middleware(request, response, next)
							.then(() => {
								assert.equal(response.set.firstCall.args[0]['Last-Modified'], bundle.createdTime.toUTCString());
							});
					});

					it('uses files expiry-time as the cache-control of the response', () => {
						return middleware(request, response, next)
							.then(() => {
								assert.equal(response.set.firstCall.args[0]['Cache-Control'], bundle.expiryTime);
							});
					});
				});
			});

			describe('bundle details', () => {

				beforeEach(() => {
					bundler.getBundle.resolves();
				});

				it('sets `babelRuntime` to false if the query parameter `polyfills` is set to none', () => {
					request.query.polyfills = 'none';
					return middleware(request, response, next)
							.then(() => {
								assert.equal(bundler.getBundle.firstCall.args[3].babelRuntime, false);
							});
				});

				it('sets `babelRuntime` to false if the query parameter `polyfills` is set to 0', () => {
					request.query.polyfills = '0';
					return middleware(request, response, next)
							.then(() => {
								assert.equal(bundler.getBundle.firstCall.args[3].babelRuntime, false);
							});
				});

				it('sets `babelRuntime` to false if the query parameter `polyfills` is set to no', () => {
					request.query.polyfills = 'no';
					return middleware(request, response, next)
							.then(() => {
								assert.equal(bundler.getBundle.firstCall.args[3].babelRuntime, false);
							});
				});

				it('sets `babelRuntime` to false if the query parameter `polyfills` is set to false', () => {
					request.query.polyfills = 'false';
					return middleware(request, response, next)
							.then(() => {
								assert.equal(bundler.getBundle.firstCall.args[3].babelRuntime, false);
							});
				});

				it('sets `babelRuntime` to true if the query parameter `polyfills` is not set', () => {
					request.query.polyfills = undefined;
					return middleware(request, response, next)
							.then(() => {
								assert.equal(bundler.getBundle.firstCall.args[3].babelRuntime, true);
							});
				});

				it('sets `babelRuntime` to true if the query parameter `polyfills` is not `none`/`0`/`no`/`false`', () => {
					request.query.polyfills = 'test';
					return middleware(request, response, next)
							.then(() => {
								assert.equal(bundler.getBundle.firstCall.args[3].babelRuntime, true);
							});
				});

				it('sets `newerthan` to unixtime representation of the query paramater `newerthan`, if it is parseable as a Date', () => {
					const now = new Date().toISOString();
					request.query.newerthan = now;
					return middleware(request, response, next)
							.then(() => {
								assert.equal(bundler.getBundle.firstCall.args[3].newerThan, Date.parse(now));
							});
				});

				it('sets `newerthan` to undefined if the query paramater `newerthan` is not parseable as a Date', () => {
					request.query.newerthan = 'not a thing';
					return middleware(request, response, next)
							.then(() => {
								assert.isNaN(bundler.getBundle.firstCall.args[3].newerThan);
							});
				});

				it('sets `newerthan` to false if the query paramater `newerthan` is not set', () => {
					request.query.newerthan = undefined;
					return middleware(request, response, next)
							.then(() => {
								assert.equal(bundler.getBundle.firstCall.args[3].newerThan, false);
							});
				});

				it('sets `versionLocks` to if the query parameter `shrinkwrap` is set', () => {
					request.query.shrinkwrap = 'o-test-component@1.0.17';
					return middleware(request, response, next)
						.then(() => {
								assert.calledTwice(ModuleSet);
								assert.calledWithExactly(ModuleSet, [ 'o-test-component@1.0.17' ]);
								assert.deepEqual(bundler.getBundle.firstCall.args[3].versionLocks, ModuleSet.mockModuleSet);
							});
				});

				it('sets `minify` to false if the query parameter `minify` is set to none', () => {
					request.query.minify = 'none';
					return middleware(request, response, next)
							.then(() => {
								assert.equal(bundler.getBundle.firstCall.args[3].minify, false);
							});
				});

				it('sets `minify` to true if it is not set as a query parameter', () => {
					request.query.minify = undefined;
					return middleware(request, response, next)
							.then(() => {
								assert.equal(bundler.getBundle.firstCall.args[3].minify, true);
							});
				});

				it('sets `minify` to true if the query parameter `minify` is not `none`', () => {
					request.query.minify = 'test';
					return middleware(request, response, next)
							.then(() => {
								assert.equal(bundler.getBundle.firstCall.args[3].minify, true);
							});
				});

				it('sets `exportName` to the value of the query parameter `export`', () => {
					request.query.export = 'salmon';
					return middleware(request, response, next)
							.then(() => {
								assert.equal(bundler.getBundle.firstCall.args[3].exportName, 'salmon');
							});
				});

				it('sets `exportName` to `Origami` if the query parameter `export` is not set', () => {
					request.query.export = undefined;
					return middleware(request, response, next)
							.then(() => {
								assert.equal(bundler.getBundle.firstCall.args[3].exportName, 'Origami');
							});
				});
			});
		});

	});

});