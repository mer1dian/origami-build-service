'use strict';

const URL = require('url');


/**
 * Given a bundleType, and a map of requestedComponents and all installed
 * components, creates a String that represents the URL that shrinkwraps the
 * installation.
 */
module.exports.toUrl = function(bundleType, requestedComponents, allComponents, endpointVersion, options) {
	const opts = options || {};
	const query = {
		modules: _createFixedVersionsQueryString(requestedComponents),
		shrinkwrap: _createFixedVersionsQueryString(allComponents, function(componentName) {
			return componentName in requestedComponents;
		})
	};
	if (opts.babelRuntime === false) {
		query.polyfills = 'false';
	}

	const url = {
		host: '',
		pathname: '/' + endpointVersion + '/bundles/' + bundleType,
		query: query
	};

	return URL.format(url);
};


function _createFixedVersionsQueryString(components, filterMethod) {
	return Object.keys(components).reduce(function(currentValue, componentName) {
		const componentInfo = components[componentName];
		const actualVersion = componentInfo.version;
		let componentVersionTargetString;

		if (componentInfo.originalSource.indexOf('/') !== -1) {
			componentVersionTargetString = componentInfo.originalSource;
		} else {
			componentVersionTargetString = componentName + '@' + actualVersion;
		}

		// If the component matches a filter, don't include it in the list
		if (filterMethod) {
			if (filterMethod(componentName)) {
				return currentValue;
			}
		}

		if (currentValue === '') {
			return componentVersionTargetString;
		}

		return currentValue + ',' + componentVersionTargetString;
	}, '');
}
