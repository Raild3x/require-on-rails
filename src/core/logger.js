// The channel is duck-typed rather than typed as vscode.LogOutputChannel so that this module,
// like its callers, stays importable outside the extension host.
/**
 * @typedef {object} LogChannel
 * @property {(message: string) => void} appendLine
 * @property {(message: string) => void} [info]
 * @property {(message: string) => void} [warn]
 * @property {(message: string) => void} [error]
 * @property {(message: string) => void} [debug]
 * @property {(message: string) => void} [trace]
 * @property {(preserveFocus?: boolean) => void} [show]
 */

/** @type {LogChannel | null} */
let outputChannel = null;

/** @param {LogChannel | null} channel */
function setOutputChannel(channel) {
    outputChannel = channel;
}

// Reveals the RequireOnRails output channel, for notifications that offer a "Show Details".
function showOutputChannel() {
    if (outputChannel && typeof outputChannel.show === 'function') outputChannel.show(true);
}

/**
 * Message text from an unknown thrown value. A `catch` binding is `unknown`, and a thrown
 * non-Error still has to render in a log line.
 * @param {unknown} e
 * @returns {string}
 */
function errMsg(e) {
    return e instanceof Error ? e.message : String(e);
}

/**
 * @param {unknown[]} args
 * @returns {string}
 */
function format(args) {
    return args.map(a => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || a.message;
        try {
            return JSON.stringify(a);
        } catch (e) {
            return String(a); // circular / unserializable
        }
    }).join(' ');
}

// Levels below info go to the output channel only; console.* would bypass the
// user's chosen log level and spam the dev console.
/**
 * @param {'debug' | 'trace'} method
 * @param {unknown[]} args
 */
function channelOnly(method, args) {
    const channel = outputChannel;
    if (channel && typeof channel[method] === 'function') {
        channel[method](format(args));
    }
}

/** @param {...unknown} args */
function print(...args) {
    const message = format(args);
    console.log(message);
    if (outputChannel) {
        if (typeof outputChannel.info === 'function') outputChannel.info(message);
        else outputChannel.appendLine(message);
    }
}

/** @param {...unknown} args */
function warn(...args) {
    const message = format(args);
    console.warn(message);
    if (outputChannel) {
        if (typeof outputChannel.warn === 'function') outputChannel.warn(message);
        else outputChannel.appendLine(`[WARN] ${message}`);
    }
}

/** @param {...unknown} args */
function error(...args) {
    const message = format(args);
    console.error(message);
    if (outputChannel) {
        if (typeof outputChannel.error === 'function') outputChannel.error(message);
        else outputChannel.appendLine(`[ERROR] ${message}`);
    }
}

/** @param {...unknown} args */
function debug(...args) {
    channelOnly('debug', args);
}

/** @param {...unknown} args */
function trace(...args) {
    channelOnly('trace', args);
}

module.exports = {
    setOutputChannel,
    showOutputChannel,
    errMsg,
    print,
    warn,
    error,
    debug,
    trace
};
