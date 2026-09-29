const units = ['Б', 'КиБ', 'МиБ', 'ГиБ', 'ТиБ', 'ПиБ'];
const numberFormat = new Intl.NumberFormat('ru-RU', {
  maximumFractionDigits: 2,
});

export function formatBytes(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return '—';

  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return numberFormat.format(value) + ' ' + units[unit];
}