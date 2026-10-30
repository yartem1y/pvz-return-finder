import { appendFile, readFile, writeFile } from 'node:fs/promises';

const CONFIG = Object.freeze({
  pointsRange: "'Данные пунктов выдачи 2'!A:G",
  citiesRange: "'Города без ПВЗ'!A:A",
  outputPath: 'pvz.json',
  allowedTypes: new Set(['magnit_store', 'partner_pvz', 'yandex_pvz']),
  pointHeaders: ['code', 'address', 'latitude', 'longitude', 'city', 'is_active', 'type'],
  minimumPointCount: 1_000,
  maximumPointDropRatio: 0.1,
  maximumActiveDropRatio: 0.2,
});

function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeKey(value) {
  return cleanText(value).toLocaleLowerCase('ru').replace(/ё/g, 'е');
}

function parseNumber(value) {
  if (typeof value === 'number') return value;
  const normalized = cleanText(value).replace(/\s/g, '').replace(',', '.');
  return normalized ? Number(normalized) : Number.NaN;
}

function parseBoolean(value) {
  if (value === true || value === false) return value;
  const normalized = normalizeKey(value);
  if (['true', 'истина'].includes(normalized)) return true;
  if (['false', 'ложь'].includes(normalized)) return false;
  return null;
}

function codeMatchesType(code, type) {
  if (type === 'magnit_store') return /^.+%.+$/.test(code);
  if (type === 'partner_pvz') return /^.+-.+$/.test(code);
  if (type === 'yandex_pvz') return /^.+\^.+$/.test(code);
  return false;
}

function readCities(rows) {
  const header = normalizeKey(rows[0]?.[0]);
  if (header !== 'город') {
    throw new Error(`На листе "Города без ПВЗ" в A1 ожидался заголовок "Город", получено "${cleanText(rows[0]?.[0]) || 'пусто'}".`);
  }

  const cities = [];
  const seen = new Set();
  const warnings = [];

  rows.slice(1).forEach((row, index) => {
    const city = cleanText(row[0]);
    if (!city) return;
    const key = normalizeKey(city);
    if (seen.has(key)) {
      warnings.push(`Лист "Города без ПВЗ", строка ${index + 2}: город "${city}" указан повторно.`);
      return;
    }
    seen.add(key);
    cities.push(city);
  });

  return { cities, cityKeys: seen, warnings };
}

function readPoints(rows, cityKeys) {
  const headers = (rows[0] || []).map(normalizeKey);
  const missingHeaders = CONFIG.pointHeaders.filter(header => !headers.includes(header));
  if (missingHeaders.length) {
    throw new Error(`На листе "Данные пунктов выдачи 2" не найдены колонки: ${missingHeaders.join(', ')}.`);
  }

  const column = Object.fromEntries(CONFIG.pointHeaders.map(header => [header, headers.indexOf(header)]));
  const points = [];
  const errors = [];
  const warnings = [];
  const codeRows = new Map();
  let unknownPointCount = 0;

  rows.slice(1).forEach((row, index) => {
    const sheetRow = index + 2;
    const code = cleanText(row[column.code]);
    const address = cleanText(row[column.address]);
    const city = cleanText(row[column.city]);
    const type = normalizeKey(row[column.type]);
    const latitudeValue = row[column.latitude];
    const longitudeValue = row[column.longitude];
    const isActiveValue = row[column.is_active];
    const hasAnyData = [code, address, city, type, latitudeValue, longitudeValue, isActiveValue]
      .some(value => cleanText(value));

    if (!hasAnyData) return;
    if (type === 'unknown') {
      unknownPointCount += 1;
      return;
    }

    const rowErrors = [];
    if (!code) rowErrors.push(`Строка ${sheetRow}: не заполнен code.`);
    if (!address) rowErrors.push(`Строка ${sheetRow}, ${code || 'без code'}: не заполнен address.`);
    if (!city) rowErrors.push(`Строка ${sheetRow}, ${code || 'без code'}: не заполнен city.`);

    const latitude = parseNumber(latitudeValue);
    const longitude = parseNumber(longitudeValue);
    const isActive = parseBoolean(isActiveValue);

    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      rowErrors.push(`Строка ${sheetRow}, ${code || 'без code'}: некорректная latitude.`);
    }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      rowErrors.push(`Строка ${sheetRow}, ${code || 'без code'}: некорректная longitude.`);
    }
    if (isActive === null) {
      rowErrors.push(`Строка ${sheetRow}, ${code || 'без code'}: is_active должен быть TRUE или FALSE.`);
    }
    if (!CONFIG.allowedTypes.has(type)) {
      rowErrors.push(`Строка ${sheetRow}, ${code || 'без code'}: неизвестный type "${type || 'пусто'}".`);
    } else if (!codeMatchesType(code, type)) {
      rowErrors.push(`Строка ${sheetRow}, ${code}: code не соответствует type "${type}".`);
    }

    if (code) {
      const codeKey = normalizeKey(code);
      if (codeRows.has(codeKey)) {
        rowErrors.push(`Строка ${sheetRow}, ${code}: code уже используется в строке ${codeRows.get(codeKey)}.`);
      } else {
        codeRows.set(codeKey, sheetRow);
      }
    }

    if (isActive === true && type === 'yandex_pvz') {
      rowErrors.push(`Строка ${sheetRow}, ${code}: yandex_pvz не может быть активным.`);
    }
    if (isActive === true && cityKeys.has(normalizeKey(city))) {
      rowErrors.push(`Строка ${sheetRow}, ${code}: активная точка находится в городе без ПВЗ "${city}".`);
    }
    if (/^заменить$/i.test(address)) {
      warnings.push(`Строка ${sheetRow}, ${code}: в address указано "Заменить".`);
    }

    if (rowErrors.length) {
      errors.push(...rowErrors);
      return;
    }

    points.push({ code, address, latitude, longitude, city, is_active: isActive, type });
  });

  return { points, errors, warnings, unknownPointCount };
}

async function fetchSheetRanges(spreadsheetId, accessToken) {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet`);
  url.searchParams.append('ranges', CONFIG.pointsRange);
  url.searchParams.append('ranges', CONFIG.citiesRange);
  url.searchParams.set('majorDimension', 'ROWS');
  url.searchParams.set('valueRenderOption', 'UNFORMATTED_VALUE');

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google Sheets API вернул ${response.status}: ${body.slice(0, 500)}`);
  }

  const result = await response.json();
  if (!Array.isArray(result.valueRanges) || result.valueRanges.length !== 2) {
    throw new Error('Google Sheets API не вернул оба ожидаемых диапазона.');
  }
  return result.valueRanges.map(range => range.values || []);
}

function comparablePayload(payload) {
  return {
    schema_version: payload.schema_version,
    cities_without_pvz: payload.cities_without_pvz,
    points: payload.points,
  };
}

function assertSafeChange(currentPayload, nextPayload) {
  const nextPointCount = nextPayload.points.length;
  if (nextPointCount < CONFIG.minimumPointCount) {
    throw new Error(`Получено только ${nextPointCount} точек. Автоматическое обновление заблокировано.`);
  }
  if (!currentPayload?.points?.length) return;

  const currentPointCount = currentPayload.points.length;
  const pointDropRatio = (currentPointCount - nextPointCount) / currentPointCount;
  if (pointDropRatio > CONFIG.maximumPointDropRatio) {
    throw new Error(`Количество точек уменьшилось с ${currentPointCount} до ${nextPointCount} более чем на 10%.`);
  }

  const currentActiveCount = currentPayload.points.filter(point => point.is_active === true).length;
  const nextActiveCount = nextPayload.points.filter(point => point.is_active === true).length;
  if (currentActiveCount > 0) {
    const activeDropRatio = (currentActiveCount - nextActiveCount) / currentActiveCount;
    if (activeDropRatio > CONFIG.maximumActiveDropRatio) {
      throw new Error(`Количество активных точек уменьшилось с ${currentActiveCount} до ${nextActiveCount} более чем на 20%.`);
    }
  }
}

async function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, 'utf8');
}

async function main() {
  const spreadsheetId = cleanText(process.env.GOOGLE_SPREADSHEET_ID);
  const accessToken = cleanText(process.env.GOOGLE_ACCESS_TOKEN);
  if (!spreadsheetId) throw new Error('Не задана переменная GOOGLE_SPREADSHEET_ID.');
  if (!accessToken) throw new Error('Не получен короткоживущий токен Google.');

  const [pointRows, cityRows] = await fetchSheetRanges(spreadsheetId, accessToken);
  const cityResult = readCities(cityRows);
  const pointResult = readPoints(pointRows, cityResult.cityKeys);

  if (pointResult.errors.length) {
    const preview = pointResult.errors.slice(0, 20).join('\n');
    throw new Error(`Обновление заблокировано: ошибок ${pointResult.errors.length}.\n${preview}`);
  }

  let currentPayload = null;
  try {
    currentPayload = JSON.parse(await readFile(CONFIG.outputPath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const nextPayload = {
    schema_version: 1,
    updated_at: new Date().toISOString(),
    cities_without_pvz: cityResult.cities,
    points: pointResult.points,
  };
  assertSafeChange(currentPayload, nextPayload);

  const changed = JSON.stringify(comparablePayload(currentPayload || {})) !== JSON.stringify(comparablePayload(nextPayload));
  await setOutput('changed', String(changed));
  await setOutput('point_count', String(nextPayload.points.length));
  await setOutput('active_count', String(nextPayload.points.filter(point => point.is_active).length));

  console.log(JSON.stringify({
    changed,
    pointCount: nextPayload.points.length,
    activeCount: nextPayload.points.filter(point => point.is_active).length,
    cityCount: nextPayload.cities_without_pvz.length,
    unknownExcluded: pointResult.unknownPointCount,
    warningCount: cityResult.warnings.length + pointResult.warnings.length,
  }));

  if (changed) {
    await writeFile(CONFIG.outputPath, `${JSON.stringify(nextPayload, null, 2)}\n`, 'utf8');
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
