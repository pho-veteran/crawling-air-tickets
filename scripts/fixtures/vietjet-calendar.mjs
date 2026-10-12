// Offline Vietjet calendar cards; all prices are simulated, never live quotes.
import {dateRange} from '../../src/providers/vna.mjs';

export function calendarHtml(from, to, quotes) {
  return 'Giá vé chỉ áp dụng cho chuyến bay một chiều\n' + quotes.map(({date, price, fare = 'Eco'}) =>
    `<div class="price-calendar" data-startdate="${date}" data-origin="${from}" data-destination="${to}" data-currency="VND" data-triptype="oneway" data-faretype="${fare}"><span class="price-bold">${price}</span><span class="price-sm">VND</span><div class="time-calendar">`
  ).join('\n');
}

export function simulatedCalendar(query, {outbound = 1800000, inbound = 2400000, failLeg} = {}) {
  const requests = [];
  return {
    requests,
    fetch: async url => {
      requests.push(url);
      const leg = url.includes('tp-ho-chi-minh-di-chu-lai') ? 'outbound' : 'inbound';
      if (leg === failLeg || failLeg === 'both') return new Response('', {status: 503});
      const out = leg === 'outbound';
      const quotes = dateRange(out ? query.departureDate : query.returnDate).map((date, i) => ({
        date, price: (out ? outbound : inbound) + (i - 3) * 10000,
      }));
      return new Response(calendarHtml(out ? query.origin : query.destination, out ? query.destination : query.origin, quotes), {
        headers: {'content-type': 'text/html'},
      });
    },
  };
}
