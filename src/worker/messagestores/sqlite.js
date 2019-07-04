const sqlite3 = require('sqlite3');
const { isoTime } = require('../../libs/helpers');
const Stats = require('../../libs/stats');

const IrcMessage = require('irc-framework').Message;

class SqliteMessageStore {
    constructor(conf) {
        this.db = new sqlite3.Database(conf.db_path || './messages.db');
        this.stats = Stats.instance().makePrefix('messages');
    }

    async init() {
        await dbRun(this.db, 'PRAGMA journal_mode = WAL');
        await dbRun(this.db, `
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            network_id INTEGER,
            buffer TEXT,
            type INTEGER,
            ts INTEGER,
            msg_id TEXT,
            message TEXT
        )`);
        await dbRun(this.db, 'CREATE INDEX IF NOT EXISTS messages_user_id_ts ON messages (user_id, ts)');
        await dbRun(this.db, 'CREATE INDEX IF NOT EXISTS messages_msg_id ON messages (msg_id)');
    }
    async getMessageByMsgId(userId, networkId, buffer, msgId) {
        let messagesTmr = this.stats.timerStart('lookup.time');

        let sql = 'SELECT * FROM messages WHERE user_id = ? AND network_id = ? AND buffer = ? AND msg_id = ? ORDER BY ts LIMIT 1';
        let rows = await dbAll(this.db, sql, [userId, networkId, buffer, msgId]);

        let messages = rows.map((row) => {
            let data = JSON.parse(row.message);
            // [message.prefix, message.tags, message.command, message.params]
            let m = new IrcMessage(data[2], ...data[3]);
            m.prefix = data[0];
            m.tags = data[1];
            m.tags.time = isoTime(new Date(row.ts));
            return m;
        });
        messagesTmr.stop();
        if(messages.length) {
            return messages[0];
        }
    }
    async getMessagesFromMsgId(userId, networkId, buffer, fromMsgId, length) {}
    async getMessagesFromTime(userId, networkId, buffer, fromTime, length) {
        let messagesTmr = this.stats.timerStart('lookup.time');

        let sql = 'SELECT * FROM messages WHERE user_id = ? AND network_id = ? AND buffer = ? AND ts > ? ORDER BY ts ASC LIMIT ?';
        let rows = await dbAll(this.db, sql, [userId, networkId, buffer, fromTime, length || 50]);

        let messages = rows.map((row) => {
            let data = JSON.parse(row.message);
            // [message.prefix, message.tags, message.command, message.params]
            let m = new IrcMessage(data[2], ...data[3]);
            m.prefix = data[0];
            m.tags = data[1];
            m.tags.time = isoTime(new Date(row.ts));
            return m;
        });

        messagesTmr.stop();
        return messages;
    }
    async getMessagesBeforeTime(userId, networkId, buffer, fromTime, length) {
        let messagesTmr = this.stats.timerStart('lookup.time');

        let sql = 'SELECT * FROM messages WHERE user_id = ? AND network_id = ? AND buffer = ? AND ts <= ? ORDER BY ts DESC LIMIT ?';
        let rows = await dbAll(this.db, sql, [userId, networkId, buffer, fromTime, length || 50]);
        rows.reverse();
        let messages = rows.map((row) => {
            let data = JSON.parse(row.message);
            // [message.prefix, message.tags, message.command, message.params]
            let m = new IrcMessage(data[2], ...data[3]);
            m.prefix = data[0];
            m.tags = data[1];
            m.tags.time = isoTime(new Date(row.ts));
            return m;
        });

        messagesTmr.stop();
        return messages;
    }
    async getMessagesAfterTime(userId, networkId, buffer, afterTime, length) {
        let messagesTmr = this.stats.timerStart('lookup.time');

        let sql = 'SELECT * FROM messages WHERE user_id = ? AND network_id = ? AND buffer = ? AND ts >= ? ORDER BY ts DESC LIMIT ?';
        let rows = await dbAll(this.db, sql, [userId, networkId, buffer, afterTime, length || 50]);
        rows.reverse();
        let messages = rows.map((row) => {
            let data = JSON.parse(row.message);
            // [message.prefix, message.tags, message.command, message.params]
            let m = new IrcMessage(data[2], ...data[3]);
            m.prefix = data[0];
            m.tags = data[1];
            m.tags.time = isoTime(new Date(row.ts));
            return m;
        });

        messagesTmr.stop();
        return messages;
    }
    async getMessagesBetweenTimes(userId, networkId, buffer, startTime, endTime, length) {
        let messagesTmr = this.stats.timerStart('lookup.time');

        let sql = 'SELECT * FROM messages WHERE user_id = ? AND network_id = ? AND buffer = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC LIMIT ?';
        let rows = await dbAll(this.db, sql, [userId, networkId, buffer, startTime, endTime, length || 50]);

        let messages = rows.map((row) => {
            let data = JSON.parse(row.message);
            // [message.prefix, message.tags, message.command, message.params]
            let m = new IrcMessage(data[2], ...data[3]);
            m.prefix = data[0];
            m.tags = data[1];
            m.tags.time = isoTime(new Date(row.ts));
            return m;
        });

        messagesTmr.stop();
        return messages;
    }

    async storeMessage(userId, networkId, message, conState) {
        let sql = 'INSERT INTO messages (user_id, network_id, buffer, type, ts, msg_id, message) VALUES (?, ?, ?, ?, ?, ?, ?)';
        let bufferName = '';
        let type = 0;
        let data = '';
        let msgId = '';
        // If no prefix, it's because we're sending it upstream
        let prefix = message.prefix || conState.nick;
        let time = message.tags.time || isoTime();

        if (message.command === 'PRIVMSG') {
            type = 1;
            bufferName = bufferNameIfPm(message, conState.nick, 0);
            data = JSON.stringify([prefix, message.tags, message.command, message.params]);
            msgId = message.tags['draft/msgid'] || message.tags['msgid'] || '';
        } else if (message.command === 'NOTICE') {
            type = 2;
            bufferName = bufferNameIfPm(message, conState.nick, 0);
            data = JSON.stringify([prefix, message.tags, message.command, message.params]);
            msgId = message.tags['draft/msgid'] || message.tags['msgid'] || '';
        }
        
        if (!type) {
            return;
        }

        let messagesTmr = this.stats.timerStart('store.time');
        await dbRun(this.db, sql, [
            userId,
            networkId,
            bufferName,
            type,
            Date.now(),
            msgId,
            data,
        ]);
        messagesTmr.stop();
    }
}

module.exports = SqliteMessageStore;

function bufferNameIfPm(message, nick, messageNickIdx) {
    if (nick.toLowerCase() === message.params[messageNickIdx]) {
        // It's a PM
        return message.nick;
    } else {
        return message.params[messageNickIdx];
    }
}

function dbRun(db, sql, params) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, (err) => {
            if (err) {
                reject(err);
            }

            resolve();
        });
    });
}

function dbAll(db, sql, params) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) {
                reject(err);
            }

            resolve(rows);
        });
    });
}