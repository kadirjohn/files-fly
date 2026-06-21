/**
 * routes/session.js — Session Route'ları (Re-export)
 * 
 * Session route'ları middleware/session.js içinde tanımlanmıştır.
 * Bu dosya, server.js'in require('./routes/session') çağrısını karşılamak için
 * middleware/session.js'i yükler.
 */

// Session route'ları middleware/session.js'de addRoute ile kaydedildi
// Bu require sadece modülün yüklenmesini ve route'ların register edilmesini sağlar
require('../middleware/session');

module.exports = {};
