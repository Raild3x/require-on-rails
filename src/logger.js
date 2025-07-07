let outputChannel = null;

function setOutputChannel(channel) {
    outputChannel = channel;
}

function print(...args) {
    const message = args.join(' ');
    console.log(message);
    if (outputChannel) {
        outputChannel.appendLine(message);
    }
}

function warn(...args) {
    const message = args.join(' ');
    console.warn(message);
    if (outputChannel) {
        outputChannel.appendLine(`[WARN] ${message}`);
    }
}

function error(...args) {
    const message = args.join(' ');
    console.error(message);
    if (outputChannel) {
        outputChannel.appendLine(`[ERROR] ${message}`);
    }
}

module.exports = {
    setOutputChannel,
    print,
    warn,
    error
};
