const EventEmitter = require('events');
const { isoTime } = require('../libs/helpers');
const ReplyRouter = require('./replyrouter');

/**
 * Tap into some hooks to modify messages and capabilities
 */

let commandHooks = new EventEmitter();
module.exports = commandHooks;

// Some caps to always request
commandHooks.on('available_caps', event => {
    event.caps.push('batch');
});

// server-time support
commandHooks.on('message_to_client', event => {
    let caps = event.client.state.caps;

    if (caps.includes('server-time')) {
        if (!event.message.tags['time']) {
            event.message.tags['time'] = isoTime();
        }
    } else {
        delete event.message.tags['time'];
    }
});
commandHooks.on('available_caps', event => {
    let caps = event.caps.push('server-time');
});

// away-notify support
commandHooks.on('message_to_client', event => {
    if (!event.client.state.caps.includes('away-notify') && event.message.command === 'AWAY') {
        event.halt = true;
    }
});
commandHooks.on('available_caps', event => {
    event.caps.push('away-notify');
});

// account-notify support
commandHooks.on('message_to_client', event => {
    if (!event.client.state.caps.includes('account-notify') && event.message.command === 'ACCOUNT') {
        event.halt = true;
    }
});
commandHooks.on('available_caps', event => {
    event.caps.push('account-notify');
});

// account-tag support
commandHooks.on('message_to_client', event => {
    if (!event.client.state.caps.includes('account-tag') && event.message.tags['account']) {
        delete event.message.tags['account'];
    }
});
commandHooks.on('available_caps', event => {
    event.caps.push('account-tag');
});

// extended-join support
commandHooks.on('available_caps', event => {
    if (!event.client.upstream) {
        return;
    }

    // Only allow the client to use extended-join if upstream has it
    let upstream = event.client.upstream;
    if (upstream.state.caps.includes('extended-join')) {
        event.caps.push('extended-join');
    }
});
commandHooks.on('message_to_client', event => {
    // :nick!user@host JOIN #channelname * :Real Name
    let caps = event.client.state.caps;
    let m = event.message;
    if (!caps.includes('extended-join') && m.command === 'JOIN' && m.params.length > 2) {
        // Drop the account name from the params (The * in the above example)
        m.params.splice(1, 1);
    }
});

// multi-prefix support
commandHooks.on('available_caps', event => {
    event.caps.push('multi-prefix');
});
commandHooks.on('message_to_client', event => {
    let m = event.message;
    // Only listen for 353(NAMES) and 352(WHO) replies
    if (m.command !== '353' && m.command !== '352') {
        return;
    }

    if (!event.client.upstream) {
        return;
    }

    let clientCaps = event.client.state.caps;
    let upstreamCaps = event.client.upstream.state.caps;
    if (!clientCaps.includes('multi-prefix') && upstreamCaps.includes('multi-prefix')) {
        // Make sure only one prefix is included in the message before sending them to the client

        let prefixes = event.client.upstream.state.isupports.find(token => {
            return token.indexOf('PREFIX=') === 0;
        });

        // Convert "PREFIX=(qaohv)~&@%+" to "~&@%+"
        prefixes = (prefixes || '').split('=')[1] || '';
        prefixes = prefixes.substr(prefixes.indexOf(')') + 1);

        // :server.com 353 guest = #tethys :~&@%+aji &@Attila @+alyx +KindOne Argure
        if (m.command === '353') {
            // Only keep the first prefix for each user from the userlist
            let list = m.params[3].split(' ').map(item => {
                let parts = splitPrefixAndNick(prefixes, item);
                return parts.prefixes[0] + parts.nick;
            });

            m.params[3] = list.join(' ');
        }

        // :kenny.chatspike.net 352 guest #test grawity broken.symlink *.chatspike.net grawity H@%+ :0 Mantas M.
        if (m.command === '352') {
            let remapped = '';
            let status = m.params[6] || '';
            if (status[0] === 'H' || status[0] === 'A') {
                remapped += status[0];
                status = status.substr(1);
            }

            if (status[0] === '*') {
                remapped += status[0];
                status = status.substr(1);
            }

            if (status[0]) {
                remapped += status[0];
                status = status.substr(1);
            }

            m.params[6] = remapped;
        }
    }
});

// userhost-in-names support
commandHooks.on('available_caps', event => {
    event.caps.push('userhost-in-names');
});
commandHooks.on('message_to_client', event => {
    // :server.com 353 guest = #tethys :~&@%+aji &@Attila @+alyx +KindOne Argure
    let caps = event.client.state.caps;
    let m = event.message;
    if (m.command === '353' && !caps.includes('userhost-in-names')) {
        let prefixes = event.client.upstream.state.isupports.find(token => {
            return token.indexOf('PREFIX=') === 0;
        });

        // Convert "PREFIX=(qaohv)~&@%+" to "~&@%+"
        prefixes = (prefixes || '').split('=')[1] || '';
        prefixes = prefixes.substr(prefixes.indexOf(')') + 1);

        // Make sure the user masks only contain nicks
        let list = m.params[3].split(' ').map(item => {
            let parts = splitPrefixAndNick(prefixes, item);
            let mask = parts.nick;

            let pos = mask.indexOf('!');
            if (pos === -1) {
                // No username separator, so it's safely just the nick
                return mask;
            }

            return mask.substring(0, pos)
        });

        m.params[3] = list.join(' ');
    }
});

// message reply routing
commandHooks.on('message_to_clients', event => {
    let command = event.message.command.toUpperCase();
    let clientsExpectingMsg = [];

    // Populate clientsExpectingMsg with clients expecting this command
    event.clients.forEach(client => {
        let expecting = client.state.tempGet('expecting_replies') || [];

        for (let i = 0; i < expecting.length; i++) {
            if (expecting[i].replies.find(reply => reply.cmd === command)) {
                clientsExpectingMsg.push(client);
            }
        } 
    });

    if (clientsExpectingMsg.length === 0) {
        // No specific clients are expecting this message so just let the message
        // go to them all
        return;
    }

    event.clients = clientsExpectingMsg;
    l.debug('Client was expecting this command,', command);

    // If this message is expected to be the last of its group, mark the client
    // as no longer expecting these type of messages again
    event.clients.forEach(client => {
        let expecting = client.state.tempGet('expecting_replies') || [];
        expecting.forEach((route, idx) => {
            let replies = route.replies;
            let isEnding = replies.find(reply => reply.cmd === command && reply.ending);
            if (isEnding) {
                expecting.splice(idx, 1);
            }
        });

        client.state.tempSet('expecting_replies', expecting.length > 0 ? expecting : null);
    });
});

commandHooks.on('message_from_client', event => {
    let client = event.client;
    let msg = event.message;

    let expectReplies = ReplyRouter.expectedReplies(msg);
    if (!expectReplies) {
        return;
    }

    let expecting = client.state.tempGet('expecting_replies') || [];
    expecting.push({command: msg.command.toUpperCase(), replies: expectReplies, added: Date.now()});
    l.debug('Client now expecting one of', expectReplies.map(r=>r.cmd).join(' '));
    client.state.tempSet('expecting_replies', expecting);
});


function splitPrefixAndNick(prefixes, input) {
    let itemPrefixes = '';
    let nick = '';

    for (let i = 0; i < input.length; i++) {
        if (prefixes.indexOf(input[i]) > -1) {
            itemPrefixes += input[i];
        } else {
            nick = input.substr(i + 1);
            break;
        }
    }

    return {
        nick: nick || '',
        prefixes: itemPrefixes || '',
    };
}
