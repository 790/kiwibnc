// Get a message param or return a default
module.exports.mParam = mParam;
function mParam(msg, idx, def) {
    return msg.params[idx] || def;
}

// Get a message param or a default, and return it in uppercase
module.exports.mParamU = mParamU;
function mParamU(msg, idx, def) {
    return (mParam(msg, idx, def) || '').toUpperCase();
}
