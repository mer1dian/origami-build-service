'use strict';

const sinon = require('sinon');

module.exports = sinon.stub().returns({
	_mockMorganLogger: true
});