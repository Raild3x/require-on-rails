let outputChannel = null;

function setOutputChannel(channel) {
    outputChannel = channel;
}

// Reveals the RequireOnRails output channel, for notifications that offer a "Show Details".
function showOutputChannel() {
    if (outputChannel && typeof outputChannel.show === 'function') outputChannel.show(true);
}

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
function channelOnly(method, args) {
    if (outputChannel && typeof outputChannel[method] === 'function') {
        outputChannel[method](format(args));
    }
}

function print(...args) {
    const message = format(args);
    console.log(message);
    if (outputChannel) {
        if (typeof outputChannel.info === 'function') outputChannel.info(message);
        else outputChannel.appendLine(message);
    }
}

function warn(...args) {
    const message = format(args);
    console.warn(message);
    if (outputChannel) {
        if (typeof outputChannel.warn === 'function') outputChannel.warn(message);
        else outputChannel.appendLine(`[WARN] ${message}`);
    }
}

function error(...args) {
    const message = format(args);
    console.error(message);
    if (outputChannel) {
        if (typeof outputChannel.error === 'function') outputChannel.error(message);
        else outputChannel.appendLine(`[ERROR] ${message}`);
    }
}

function debug(...args) {
    channelOnly('debug', args);
}

function trace(...args) {
    channelOnly('trace', args);
}

module.exports = {
    setOutputChannel,
    showOutputChannel,
    print,
    warn,
    error,
    debug,
    trace
};
