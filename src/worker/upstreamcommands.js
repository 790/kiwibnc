const { mParam, mParamU } = require('../libs/helpers');
const hooks = require('./hooks');

let commands = Object.create(null);

module.exports.run = async function run(msg, con) {
    let hook = await hooks.emit('message_from_upstream', {client: con, message: msg});
    if (hook.prevent) {
        return;
    }

    let command = msg.command.toUpperCase();
    if (commands[command]) {
        return await commands[command](msg, con);
    }

    // By default, send any unprocessed lines to clients
    return true;
};

commands['CAP'] = async function(msg, con) {
    // :irc.example.net CAP * LS :invite-notify ...
    if (mParamU(msg, 1, '') === 'LS') {
        let offeredCaps = mParam(msg, 2, '').split(' ');
        let wantedCaps = [
            'server-time',
            'multi-prefix',
            'away-notify',
            'account-notify',
            'account-tag',
            'extended-join',
            'userhost-in-names',
        ];
        let requestingCaps = offeredCaps.filter((cap) => wantedCaps.includes(cap));
        if (requestingCaps.length === 0) {
            con.writeLine('CAP', 'END');
        } else {
            con.writeLine('CAP', 'REQ', requestingCaps.join(' '));
        }
    }

    // We only expect one ACK so just CAP END it here
    if (mParamU(msg, 1, '') === 'ACK') {
        let caps = mParam(msg, 2, '').split(' ');
        con.state.caps = con.state.caps.concat(caps);
        await con.state.save();
        con.writeLine('CAP', 'END');
    }

    return false;
};

commands['001'] = async function(msg, con) {
    con.state.nick = msg.params[0];
    con.state.serverPrefix = msg.prefix || '';
    con.state.netRegistered = true;
    con.state.registrationLines.push([msg.command, msg.params.slice(1)]);
    con.state.save();

    con.forEachClient((clientCon) => {
        clientCon.registerClient();
    });

    for (let buffName in con.state.buffers) {
        let b = con.state.buffers[buffName];
        if (b.isChannel && b.joined) {
            con.writeLine('JOIN', b.name);
        }
    }

    return false;
};
commands['002'] = async function(msg, con) {
    con.state.registrationLines.push([msg.command, msg.params.slice(1)]);
    con.state.save();
    return false;
};
commands['004'] = async function(msg, con) {
    con.state.registrationLines.push([msg.command, msg.params.slice(1)]);
    con.state.save();
    return false;
};
commands['004'] = async function(msg, con) {
    con.state.registrationLines.push([msg.command, msg.params.slice(1)]);
    con.state.save();
    return false;
};

// Keep track of our isupport tokens
commands['005'] = async function(msg, con) {
    // Take these new tokens and add them to our existing recorded tokens
    let tokens = msg.params.slice(1);
    tokens.pop();
    con.state.isupports = [...con.state.isupports, ...tokens];

    con.state.registrationLines.push([msg.command, msg.params.slice(1)]);
    con.state.save();
    return false;
};

commands.PING = async function(msg, con) {
    con.write('PONG :' + msg.params[0] + '\n');
    return false;
};

commands.JOIN = async function(msg, con) {
    if (msg.nick.toLowerCase() !== con.state.nick.toLowerCase()) {
        return;
    }

    let chanName = msg.params[0];
    let chan = con.state.getBuffer(chanName);
    if (!chan) {
        chan = con.state.addBuffer(chanName, con);
    }

    chan.joined = true;
    await con.state.save();
};

commands.PART = async function(msg, con) {
    if (msg.nick.toLowerCase() !== con.state.nick.toLowerCase()) {
        return;
    }

    let chanName = msg.params[0];
    let chan = con.state.getBuffer(chanName);
    if (!chan) {
        return;
    }

    chan.joined = false;
    await con.state.save();
};

commands.KICK = async function(msg, con) {
    if (msg.params[1].toLowerCase() !== con.state.nick.toLowerCase()) {
        return;
    }

    let chanName = msg.params[0];
    let chan = con.state.getBuffer(chanName);
    if (!chan) {
        return;
    }

    chan.joined = false;
    await con.state.save();
};

// RPL_TOPIC
commands['332'] = async function(msg, con) {
    let channel = con.state.getBuffer(msg.params[1]);
    if (!channel) {
        channel = con.state.addBuffer(msg.params[1], con);
    }

    channel.topic = msg.params[2];
    await con.state.save();
};

// nick in use
// TODO: This is niave and way to simplistic to a fault. Improve
commands['433'] = async function(msg, con) {
    if (con.state.nick.length < 8) {
        con.state.nick = con.state.nick + '_';
        con.writeLine('NICK', con.state.nick);
    }
};

commands.NICK = async function(msg, con) {
    if (msg.nick.toLowerCase() !== con.state.nick.toLowerCase()) {
        let buffer = con.state.getBuffer(msg.nick);
        if (!buffer) {
            return;
        }

        // Try to track nick changes so that they stay in the same buffer instance
        con.state.renameBuffer(buffer.name, msg.params[0]);
        con.state.save();
        return;
    }

    con.state.nick = msg.params[0];
    con.state.save();
};

commands.PRIVMSG = async function(msg, con) {
    if (con.state.logging) {
        await con.messages.storeMessage(con.state.authUserId, con.state.authNetworkId, msg, con.state);
    }

    // Make sure we have this buffer
    con.state.getOrAddBuffer(bufferNameIfPm(msg, con.state.nick, 0), con);
};

commands.NOTICE = async function(msg, con) {
    if (con.state.logging) {
        await con.messages.storeMessage(con.state.authUserId, con.state.authNetworkId, msg, con.state);
    }

    // Make sure we have this buffer
    con.state.getOrAddBuffer(bufferNameIfPm(msg, con.state.nick, 0), con);
};

function bufferNameIfPm(message, nick, messageNickIdx) {
    if (nick.toLowerCase() === message.params[messageNickIdx]) {
        // It's a PM
        return message.nick;
    } else {
        return message.params[messageNickIdx];
    }
}