// content/utils/coords.js
// Конвертация координат WGS-84 ↔ СК-42.
// Зависимость: proj4.js (подключается в manifest.json перед этим файлом).

function convertWgs84ToSk42(lon, lat) {
  if (!window.proj4) {
    console.warn('[coords] proj4 не загружен');
    return { x: lon, y: lat };
  }
  try {
    const wgs84 = 'EPSG:4326';
    const zone  = Math.floor((lon + 6) / 6);
    const lon0  = zone * 6 - 3;
    const sk42  = `+proj=tmerc +lat_0=0 +lon_0=${lon0} +k=1 +x_0=${zone * 1000000 + 500000} +y_0=0 +ellps=krass +units=m +no_defs`;
    const [x, y] = proj4(wgs84, sk42, [lon, lat]);
    return { x: Math.round(x), y: Math.round(y) };
  } catch (err) {
    console.error('[coords] Ошибка proj4 (wgs84→sk42):', err);
    return { x: lon, y: lat };
  }
}

function convertSk42ToWgs84(x, y) {
  if (!window.proj4) {
    console.warn('[coords] proj4 не загружен');
    return { lon: x, lat: y };
  }
  try {
    const wgs84 = 'EPSG:4326';
    const zone  = Math.floor(x / 1000000);
    const lon0  = zone * 6 - 3;
    const sk42  = `+proj=tmerc +lat_0=0 +lon_0=${lon0} +k=1 +x_0=${zone * 1000000 + 500000} +y_0=0 +ellps=krass +towgs84=23.92,-141.27,-80.9,0,0,0,0 +units=m +no_defs`;
    const [lon, lat] = proj4(sk42, wgs84, [parseFloat(x), parseFloat(y)]);
    return {
      lon: parseFloat(lon.toFixed(6)),
      lat: parseFloat(lat.toFixed(6)),
    };
  } catch (err) {
    console.error('[coords] Ошибка proj4 (sk42→wgs84):', err);
    return { lon: x, lat: y };
  }
}
