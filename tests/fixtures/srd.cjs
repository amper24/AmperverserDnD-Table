// Записи SRD так, как их отдаёт сервер для просмотра: английское название из слоя i18n.en.name выставляется как name_en
// (см. src/i18n.rs, view()). Поле в данных не хранится, поэтому тесты берут записи через этот загрузчик.
const fs = require('node:fs');

module.exports = function loadSrd(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).map(record => {
    const en = record.data?.i18n?.en?.name;
    return en && !record.data.name_en ? { ...record, data: { ...record.data, name_en: en } } : record;
  });
};
