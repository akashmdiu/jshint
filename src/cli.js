"use strict";

var _           = require("underscore");
var cli         = require("cli");
var path        = require("path");
var shjs        = require("shelljs");
var minimatch   = require("minimatch");
var htmlparser  = require("htmlparser2");
var JSHINT      = require("./jshint.js").JSHINT;
var defReporter = require("./reporters/default").reporter;

var OPTIONS = {
	"config": ["c", "Custom configuration file", "string", false ],
	"reporter": ["reporter", "Custom reporter (<PATH>|jslint|checkstyle)", "string", undefined ],
	"exclude": ["exclude",
		"Exclude files matching the given filename pattern (same as .jshintignore)", "string", null],
	"exclude-path": ["exclude-path", "Pass in a custom jshintignore file path", "string", null],
	"verbose": ["verbose", "Show message codes"],
	"show-non-errors": ["show-non-errors", "Show additional data generated by jshint"],
	"extra-ext": ["e",
		"Comma-separated list of file extensions to use (default is .js)", "string", ""],

	"extract": [
		"extract",
		"Extract inline scripts contained in HTML (auto|always|never, default to never)",
		"string",
		"never"
	],

	// Deprecated options.
	"jslint-reporter": [
		"jslint-reporter",
		deprecated("Use a jslint compatible reporter", "--reporter=jslint")
	],

	"checkstyle-reporter": [
		"checkstyle-reporter",
		deprecated("Use a CheckStyle compatible XML reporter", "--reporter=checkstyle")
	]
};

/**
 * Returns the same text but with a deprecation notice.
 * Useful for options descriptions.
 *
 * @param {string} text
 * @param {string} alt (optional) Alternative command to include in the
 *								 deprecation notice.
 *
 * @returns {string}
 */
function deprecated(text, alt) {
	if (!alt) {
		return text + " (DEPRECATED)";
	}

	return text + " (DEPRECATED, use " + alt + " instead)";
}

/**
 * Removes JavaScript comments from a string by replacing
 * everything between block comments and everything after
 * single-line comments in a non-greedy way.
 *
 * English version of the regex:
 *   match '/*'
 *   then match zero or more instances of any character (incl. \n)
 *   except for instances of '* /' (without a space, obv.)
 *   then match '* /' (again, without a space)
 *
 * @param {string} str a string with potential JavaScript comments.
 * @returns {string} a string without JavaScript comments.
 */
function removeComments(str) {
	str = str || "";

	str = str.replace(/\/\*(?:(?!\*\/)[\s\S])*\*\//g, "");
	str = str.replace(/\/\/[^\n\r]*/g, ""); // Everything after '//'

	return str;
}

/**
 * Tries to find a configuration file in either project directory
 * or in the home directory. Configuration files are named
 * '.jshintrc'.
 *
 * @param {string} file path to the file to be linted
 * @returns {string} a path to the config file
 */
function findConfig(file) {
	var dir  = path.dirname(path.resolve(file));
	var envs = process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE;
	var home = path.normalize(path.join(envs, ".jshintrc"));

	var proj = findFile(".jshintrc", dir);
	if (proj)
		return proj;

	if (shjs.test("-e", home))
		return home;

	return null;
}

/**
 * Tries to find JSHint configuration within a package.json file
 * (if any). It search in the current directory and then goes up
 * all the way to the root just like findFile.
 *
 * @param   {string} file path to the file to be linted
 * @returns {object} config object
 */
function loadNpmConfig(file) {
	var dir = path.dirname(path.resolve(file));
	var fp  = findFile("package.json", dir);

	if (!fp)
		return null;

	try {
		return require(fp).jshintConfig;
	} catch (e) {
		return null;
	}
}

/**
 * Tries to import a reporter file and returns its reference.
 *
 * @param {string} fp a path to the reporter file
 * @returns {object} imported module for the reporter or 'null'
 *									 if a module cannot be imported.
 */
function loadReporter(fp) {
	try {
		return require(fp).reporter;
	} catch (err) {
		return null;
	}
}

// Storage for memoized results from find file
// Should prevent lots of directory traversal &
// lookups when liniting an entire project
var findFileResults = {};

/**
 * Searches for a file with a specified name starting with
 * 'dir' and going all the way up either until it finds the file
 * or hits the root.
 *
 * @param {string} name filename to search for (e.g. .jshintrc)
 * @param {string} dir  directory to start search from (default:
 *										  current working directory)
 *
 * @returns {string} normalized filename
 */
function findFile(name, dir) {
	dir = dir || process.cwd();

	var filename = path.normalize(path.join(dir, name));
	if (findFileResults[filename] !== undefined) {
		return findFileResults[filename];
	}

	var parent = path.resolve(dir, "../");

	if (shjs.test("-e", filename)) {
		findFileResults[filename] = filename;
		return filename;
	}

	if (dir === parent) {
		findFileResults[filename] = null;
		return null;
	}

	return findFile(name, parent);
}

/**
 * Loads a list of files that have to be skipped. JSHint assumes that
 * the list is located in a file called '.jshintignore'.
 *
 * @return {array} a list of files to ignore.
 */
function loadIgnores(exclude, excludePath) {
	var file = findFile(excludePath || ".jshintignore");

	if (!file && !exclude) {
		return [];
	}

	var lines = (file ? shjs.cat(file) : "").split("\n");
	lines.unshift(exclude || "");

	return lines
		.filter(function (line) {
			return !!line.trim();
		})
		.map(function (line) {
			if (line[0] === "!")
				return "!" + path.resolve(path.dirname(file), line.substr(1).trim());

			return path.resolve(path.dirname(file), line.trim());
		});
}

/**
 * Checks whether we should ignore a file or not.
 *
 * @param {string} fp       a path to a file
 * @param {array}  patterns a list of patterns for files to ignore
 *
 * @return {boolean} 'true' if file should be ignored, 'false' otherwise.
 */
function isIgnored(fp, patterns) {
	return patterns.some(function (ip) {
		if (minimatch(path.resolve(fp), ip, { nocase: true })) {
			return true;
		}

		if (path.resolve(fp) === ip) {
			return true;
		}

		if (shjs.test("-d", fp) && ip.match(/^[^\/]*\/?$/) &&
			fp.match(new RegExp("^" + ip + ".*"))) {
			return true;
		}
	});
}

/**
 * Extract JS code from a given source code. The source code my be either HTML
 * code or JS code. In the latter case, no extraction will be done unless
 * 'always' is given.
 *
 * @param {string} code a piece of code
 * @param {string} when 'always' will extract the JS code, no matter what.
 * 'never' won't do anything. 'auto' will check if the code looks like HTML
 * before extracting it.
 *
 * @return {string} the extracted code
 */
function extract(code, when) {
	// A JS file won't start with a less-than character, whereas a HTML file
	// should always start with that.
	if (when !== "always" && (when !== "auto" || !/^\s*</.test(code)))
		return code;

	var inscript = false;
	var index = 0;
	var js = [];

	// Test if current tag is a valid <script> tag.
	function onopen(name, attrs) {
		if (name !== "script")
			return;

		if (attrs.type && !/text\/javascript/.test(attrs.type.toLowerCase()))
			return;

		// Mark that we're inside a <script> a tag and push all new lines
		// in between the last </script> tag and this <script> tag to preserve
		// location information.
		inscript = true;
		js.push.apply(js, code.slice(index, parser.endIndex).match(/\n\r|\n|\r/g));
	}

	function onclose(name) {
		if (name !== "script" || !inscript)
			return;

		inscript = false;
		index = parser.startIndex;
	}

	function ontext(data) {
		if (inscript)
			js.push(data); // Collect JavaScript code.
	}

	var parser = new htmlparser.Parser({ onopentag: onopen, onclosetag: onclose, ontext: ontext });
	parser.parseComplete(code);

	return js.join("");
}

/**
 * Recursively gather all files that need to be linted,
 * excluding those that user asked to ignore.
 *
 * @param {string} fp      a path to a file or directory to lint
 * @param {array}  files   a pointer to an array that stores a list of files
 * @param {array}  ignores a list of patterns for files to ignore
 * @param {array}  ext     a list of non-dot-js extensions to lint
 */
function collect(fp, files, ignores, ext) {
	if (ignores && isIgnored(fp, ignores)) {
		return;
	}

	if (!shjs.test("-e", fp)) {
		cli.error("Can't open " + fp);
		return;
	}

	if (shjs.test("-d", fp)) {
		shjs.ls(fp).forEach(function (item) {
			var itempath = path.join(fp, item);
			if (shjs.test("-d", itempath) || item.match(ext)) {
				collect(itempath, files, ignores, ext);
			}
		});

		return;
	}

	files.push(fp);
}

/**
 * Runs JSHint against provided file and saves the result
 *
 * @param {string} code    code that needs to be linted
 * @param {object} results a pointer to an object with results
 * @param {object} config  an object with JSHint configuration
 * @param {object} data    a pointer to an object with extra data
 * @param {string} file    (optional) file name that is being linted
 */
function lint(code, results, config, data, file) {
	var globals;
	var lintData;
	var buffer = [];

	config = config || {};
	config = JSON.parse(JSON.stringify(config));

	if (config.prereq) {
		config.prereq.forEach(function (fp) {
			fp = path.join(config.dirname, fp);
			if (shjs.test("-e", fp))
				buffer.push(shjs.cat(fp));
		});
		delete config.prereq;
	}

	if (config.globals) {
		globals = config.globals;
		delete config.globals;
	}

	delete config.dirname;
	buffer.push(code);
	buffer = buffer.join("\n");
	buffer = buffer.replace(/^\uFEFF/, ""); // Remove potential Unicode BOM.

	if (!JSHINT(buffer, config, globals)) {
		JSHINT.errors.forEach(function (err) {
			if (err) {
				results.push({ file: file || "stdin", error: err });
			}
		});
	}

	lintData = JSHINT.data();

	if (lintData) {
		lintData.file = file || "stdin";
		data.push(lintData);
	}
}

var exports = {
	extract: extract,

	/**
	 * Loads and parses a configuration file.
	 *
	 * @param {string} fp a path to the config file
	 * @returns {object} config object
	 */
	loadConfig: function (fp) {
		if (!fp) {
			return {};
		}

		if (!shjs.test("-e", fp)) {
			cli.error("Can't find config file: " + fp);
			process.exit(1);
		}

		try {
			var config = JSON.parse(removeComments(shjs.cat(fp)));
			config.dirname = path.dirname(fp);

			if (config['extends']) {
				_.extend(config, exports.loadConfig(path.resolve(config.dirname, config['extends'])));
				delete config['extends'];
			}

			return config;
		} catch (err) {
			cli.error("Can't parse config file: " + fp);
			process.exit(1);
		}
	},

	/**
	 * Gathers all files that need to be linted
	 *
	 * @param {object} post-processed options from 'interpret':
	 *								   args     - CLI arguments
	 *								   ignores  - A list of files/dirs to ignore (defaults to .jshintignores)
	 *								   extensions - A list of non-dot-js extensions to check
	 */
	gather: function (opts) {
		var files = [];

		var reg = new RegExp("\\.(js" +
			(!opts.extensions ? "" : "|" +
				opts.extensions.replace(/,/g, "|").replace(/[\. ]/g, "")) + ")$");

		var ignores = !opts.ignores ? loadIgnores() : opts.ignores.map(function (target) {
			return path.resolve(target);
		});

		opts.args.forEach(function (target) {
			collect(target, files, ignores, reg);
		});

		return files;
	},

	/**
	 * Gathers all files that need to be linted, lints them, sends them to
	 * a reporter and returns the overall result.
	 *
	 * @param {object} post-processed options from 'interpret':
	 *                 args     - CLI arguments
	 *                 config   - Configuration object
	 *                 reporter - Reporter function
	 *                 ignores  - A list of files/dirs to ignore
	 *                 extensions - A list of non-dot-js extensions to check
	 * @param {function} cb a callback to call when function is finished
	 *                   asynchronously.
	 *
	 * @returns {bool} 'true' if all files passed, 'false' otherwise and 'null'
	 *                 when function will be finished asynchronously.
	 */
	run: function (opts, cb) {
		var files = exports.gather(opts);
		var results = [];
		var data = [];

		if (opts.useStdin) {
			cli.withStdin(function (code) {
				lint(extract(code, opts.extract), results, opts.config || {}, data);
				(opts.reporter || defReporter)(results, data, { verbose: opts.verbose });
				cb(results.length === 0);
			});

			return null;
		}

		files.forEach(function (file) {
			var config = opts.config || loadNpmConfig(file) || exports.loadConfig(findConfig(file));
			var code;

			try {
				code = shjs.cat(file);
			} catch (err) {
				cli.error("Can't open " + file);
				process.exit(1);
			}

			lint(extract(code, opts.extract), results, config, data, file);
		});

		(opts.reporter || defReporter)(results, data, { verbose: opts.verbose });
		return results.length === 0;
	},

	/**
	 * Helper exposed for testing.
	 * Used to determine is stdout has any buffered output before exiting the program
	 */
	getBufferSize: function () {
		return process.stdout.bufferSize;
	},

	/**
	 * Main entrance function. Parses arguments and calls 'run' when
	 * its done. This function is called from bin/jshint file.
	 *
	 * @param {object} args, arguments in the process.argv format.
	 */
	interpret: function (args) {
		cli.setArgv(args);
		cli.options = {};

		cli.enable("version", "glob", "help");
		cli.setApp(path.resolve(__dirname + "/../package.json"));

		var options = cli.parse(OPTIONS);
		// Use config file if specified
		var config;
		if (options.config) {
			config = exports.loadConfig(options.config);
		}

		switch (true) {
		// JSLint reporter
		case options.reporter === "jslint":
		case options["jslint-reporter"]:
			options.reporter = "./reporters/jslint_xml.js";
			break;

		// CheckStyle (XML) reporter
		case options.reporter === "checkstyle":
		case options["checkstyle-reporter"]:
			options.reporter = "./reporters/checkstyle.js";
			break;

		// Reporter that displays additional JSHint data
		case options["show-non-errors"]:
			options.reporter = "./reporters/non_error.js";
			break;

		// Custom reporter
		case options.reporter !== undefined:
			options.reporter = path.resolve(process.cwd(), options.reporter);
		}

		var reporter;
		if (options.reporter) {
			reporter = loadReporter(options.reporter);

			if (reporter === null) {
				cli.error("Can't load reporter file: " + options.reporter);
				process.exit(1);
			}
		}

		// This is a hack. exports.run is both sync and async function
		// because I needed stdin support (and cli.withStdin is async)
		// and was too lazy to change tests.

		function done(passed) {
			/*jshint eqnull:true */

			if (passed == null)
				return;

			// Patch as per https://github.com/visionmedia/mocha/issues/333
			// fixes issues with piped output on Windows.
			// Root issue is here https://github.com/joyent/node/issues/3584
			function exit() { process.exit(passed ? 0 : 2); }
			try {
				if (exports.getBufferSize()) {
					process.stdout.once('drain', exit);
				} else {
					exit();
				}
			} catch (err) {
				exit();
			}
		}

		done(exports.run({
			args:       cli.args,
			config:     config,
			reporter:   reporter,
			ignores:    loadIgnores(options.exclude, options["exclude-path"]),
			extensions: options["extra-ext"],
			verbose:    options.verbose,
			extract:    options.extract,
			useStdin:   {"-": true, "/dev/stdin": true}[args[args.length - 1]]
		}, done));
	}
};

module.exports = exports;
