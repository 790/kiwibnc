const Irc = require('irc-framework');
const { mParam, mParamU } = require('../../../libs/helpers');

const MAX_MESSAGES = 50;

module.exports.init = async function init(hooks) {
    hooks.on('message_from_client', event => {
        if (event.message.command.toUpperCase() === 'CHATHISTORY') {
            return handleCommand(event);
        }
    });

    hooks.on('available_isupports', async event => {
        event.tokens.push('CHATHISTORY=' + MAX_MESSAGES);
    });
};

async function handleCommand(event) {
    // CHATHISTORY ${subcommand} ${this.name} <timestamp=${timeStr} | msgid=${msgid}> ${numMessages}
    event.preventDefault();
    event.passthru = false;

    let msg = event.message;
    let con = event.client;
    let messageDb = con.messages;
    
    let subcommand = mParam(msg, 0, '').toUpperCase();
    let target = mParam(msg, 1, '');
    let [query, queryParam] = mParam(msg, 2, '').split('=');
    let msgCount = mParam(msg, 3, '');

    msgCount = parseInt(msgCount, 10);
    if (isNaN(msgCount)) {
        msgCount = MAX_MESSAGES;
    } else if (msgCount > MAX_MESSAGES) {
        msgCount = MAX_MESSAGES;
    } else if (msgCount < -MAX_MESSAGES) {
        msgCount = -MAX_MESSAGES;
    }
    
    let messages = [];
    let ts;
    if (query === '*') {
        ts = Date.now();
    } else if (query === 'timestamp') {
        ts = new Date(queryParam).getTime();
    }
    else if (query === 'msgid') {
        let msg = await messageDb.getMessageByMsgId(
            con.state.authUserId,
            con.state.authNetworkId,
            target,
            queryParam
        );
        ts = msg.ts;
    }

    if (isNaN(ts)) {
        ts = Date.now();
    }

    if (subcommand === 'LATEST' || subcommand === 'BEFORE') {
        messages = await messageDb.getMessagesBeforeTime(
            con.state.authUserId,
            con.state.authNetworkId,
            target,
            ts,
            Math.abs(msgCount)
        );
    } else if(subcommand === 'BETWEEN') {
        let [queryEnd, queryParamEnd] = mParam(msg, 3, '').split('=');
        let ts2 = new Date(queryParamEnd).getTime();
        msgCount = mParam(msg, 4, '');
        messages = await messageDb.getMessagesBetweenTimes(
            con.state.authUserId,
            con.state.authNetworkId,
            target,
            ts,
            ts2,
            Math.abs(msgCount)
        ); 
    } else if (subcommand === 'AFTER') {
        messages = await messageDb.getMessagesAfterTime(
            con.state.authUserId,
            con.state.authNetworkId,
            target,
            ts,
            Math.abs(msgCount)
        );
    } else if (subcommand === 'AROUND') {
        messages = await messageDb.getMessagesBeforeTime(
            con.state.authUserId,
            con.state.authNetworkId,
            target,
            ts,
            Math.floor(msgCount/2)
        );
        messages = message.concat(await messageDb.getMessagesAfterTime(
            con.state.authUserId,
            con.state.authNetworkId,
            target,
            ts,
            Math.floor(msgCount/2)
        ));
    }

    let batchId = Math.round(Math.random()*1e17).toString(36);

    let m = new Irc.Message('BATCH', '+' + batchId, 'chathistory', target);
    m.prefix = 'bnc';
    con.writeMsg(m);

    messages.forEach(message => {
        message.tags.batch = batchId;
        con.writeMsg(message);
    });

    m = new Irc.Message('BATCH', '-' + batchId);
    m.prefix = 'bnc';
    con.writeMsg(m);
};
