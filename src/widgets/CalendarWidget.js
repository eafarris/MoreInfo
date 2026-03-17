import { Widget }  from './Widget.js';
import { invoke } from '../tauri.js';

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];
const DAYS = ['Su','Mo','Tu','We','Th','Fr','Sa'];

export class CalendarWidget extends Widget {
  /**
   * @param {{ onDateSelected: (dateStr: string) => void }} options
   *   onDateSelected — called when the user clicks a day cell
   */
  constructor({ onDateSelected }) {
    super({ id: 'calendar', title: 'Calendar', icon: 'ph-calendar-blank' });
    this._onDateSelected = onDateSelected;
    this._journalDates   = new Set();
    this._activeDate     = null;   // YYYY-MM-DD of the currently open journal page
    const now = new Date();
    this._cal = {
      year:       now.getFullYear(),
      month:      now.getMonth(),
      view:       'days',
      pickerYear: now.getFullYear(),
    };
  }

  // Calendar takes its natural height; the last widget (Metadata) gets the rest.
  get wrapperClass() { return 'shrink-0'; }

  onMount() {
    this._render();
    this._fetchJournalDates();
  }

  onFileOpen(path, _content, _metadata) {
    const name = path.replace(/\\/g, '/').split('/').pop();
    const m    = name.match(/^(\d{4})-(\d{2})-(\d{2})\.md$/);
    if (m) {
      this._activeDate  = m[0].slice(0, 10); // YYYY-MM-DD
      this._cal.year    = parseInt(m[1], 10);
      this._cal.month   = parseInt(m[2], 10) - 1;
      this._cal.view    = 'days';
    } else {
      this._activeDate = null;
    }
    this._fetchJournalDates();
  }

  async _fetchJournalDates() {
    try {
      const dates = await invoke('list_journal_dates');
      this._journalDates = new Set(dates);
      this._render();
    } catch (e) {
      console.error('list_journal_dates failed:', e);
    }
  }

  _render() {
    if (!this._body) return;
    this._body.innerHTML = this._cal.view === 'days'
      ? this._buildDays()
      : this._buildPicker();
    this._wireEvents();
  }

  _buildDays() {
    const { year, month } = this._cal;
    const today   = new Date();
    const todayY  = today.getFullYear();
    const todayM  = today.getMonth();
    const todayD  = today.getDate();

    const firstDow    = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrev  = new Date(year, month, 0).getDate();

    let cells = '';

    for (let i = firstDow - 1; i >= 0; i--) {
      cells += `<span class="flex flex-col items-center py-0.5">
        <span class="w-6 h-6 flex items-center justify-center mx-auto text-olive-600">${daysInPrev - i}</span>
        <span class="block w-1 h-1 mx-auto mt-px invisible"></span>
      </span>`;
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const isToday    = (year === todayY && month === todayM && d === todayD);
      const dateStr    = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const isActive   = (dateStr === this._activeDate);
      const hasJournal = this._journalDates.has(dateStr);

      // Active page → bright blue fill; today only → subdued ring; neither → plain
      const numClass = isActive
        ? 'bg-amber-500 text-white font-semibold group-hover:bg-amber-400'
        : isToday
          ? 'bg-olive-700 text-olive-100 font-medium group-hover:bg-olive-600'
          : 'text-olive-300 group-hover:bg-olive-700 group-hover:text-white';
      const dotClass = hasJournal ? (isActive ? 'bg-amber-300' : 'bg-amber-500') : 'invisible';

      cells += `<button data-date="${dateStr}" class="group flex flex-col items-center py-0.5">
        <span class="w-6 h-6 rounded-full flex items-center justify-center mx-auto transition-colors ${numClass}">${d}</span>
        <span class="block w-1 h-1 rounded-full mx-auto mt-px ${dotClass}"></span>
      </button>`;
    }

    const total    = firstDow + daysInMonth;
    const trailing = total % 7 === 0 ? 0 : 7 - (total % 7);
    for (let d = 1; d <= trailing; d++) {
      cells += `<span class="flex flex-col items-center py-0.5">
        <span class="w-6 h-6 flex items-center justify-center mx-auto text-olive-600">${d}</span>
        <span class="block w-1 h-1 mx-auto mt-px invisible"></span>
      </span>`;
    }

    const dayHeaders = DAYS.map(d =>
      `<span class="text-olive-500 text-xs font-semibold">${d}</span>`
    ).join('');

    return `
      <div class="flex items-center justify-between px-3 py-2">
        <button class="cal-prev text-olive-400 hover:text-white px-1">&#8249;</button>
        <button class="cal-title text-xs font-semibold text-olive-200 hover:text-amber-400 transition-colors">
          ${MONTHS[month]} ${year}
        </button>
        <button class="cal-next text-olive-400 hover:text-white px-1">&#8250;</button>
      </div>
      <div class="grid grid-cols-7 gap-y-1 px-2 pb-3 text-center text-xs">
        ${dayHeaders}
        ${cells}
      </div>`;
  }

  _buildPicker() {
    const { pickerYear } = this._cal;
    const monthBtns = MONTHS.map((m, i) =>
      `<button data-pick-month="${i}"
        class="text-xs py-1 rounded hover:bg-olive-700 text-olive-300 hover:text-white transition-colors">
        ${m.slice(0, 3)}
      </button>`
    ).join('');

    return `
      <div class="flex items-center justify-between px-3 py-2">
        <button class="cal-picker-prev text-olive-400 hover:text-white px-1">&#8249;</button>
        <span class="text-xs font-semibold text-olive-200">${pickerYear}</span>
        <button class="cal-picker-next text-olive-400 hover:text-white px-1">&#8250;</button>
      </div>
      <div class="grid grid-cols-3 gap-1 px-2 pb-3">
        ${monthBtns}
      </div>
      <div class="px-2 pb-2 flex gap-1.5">
        <button class="cal-picker-today flex-1 text-xs py-1 rounded bg-amber-700 hover:bg-amber-600 text-white transition-colors">Today</button>
        <button class="cal-picker-cancel flex-1 text-xs py-1 rounded bg-olive-800 hover:bg-olive-700 text-olive-400 hover:text-white transition-colors">Cancel</button>
      </div>`;
  }

  _wireEvents() {
    const body = this._body;

    if (this._cal.view === 'days') {
      body.querySelector('.cal-prev').addEventListener('click', () => {
        this._cal.month--;
        if (this._cal.month < 0) { this._cal.month = 11; this._cal.year--; }
        this._render();
      });
      body.querySelector('.cal-next').addEventListener('click', () => {
        this._cal.month++;
        if (this._cal.month > 11) { this._cal.month = 0; this._cal.year++; }
        this._render();
      });
      body.querySelector('.cal-title').addEventListener('click', () => {
        this._cal.view = 'picker';
        this._cal.pickerYear = this._cal.year;
        this._render();
      });
      body.querySelector('.cal-title').addEventListener('dblclick', e => {
        e.stopPropagation();
        const now = new Date();
        this._cal.year  = now.getFullYear();
        this._cal.month = now.getMonth();
        this._cal.view  = 'days';
        this._render();
      });
      body.querySelectorAll('[data-date]').forEach(btn => {
        btn.addEventListener('click', () => this._onDateSelected(btn.dataset.date));
      });
    } else {
      body.querySelector('.cal-picker-prev').addEventListener('click', () => {
        this._cal.pickerYear--;
        this._render();
      });
      body.querySelector('.cal-picker-next').addEventListener('click', () => {
        this._cal.pickerYear++;
        this._render();
      });
      body.querySelector('.cal-picker-today').addEventListener('click', () => {
        const now = new Date();
        this._cal.year  = now.getFullYear();
        this._cal.month = now.getMonth();
        this._cal.view  = 'days';
        this._render();
        const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        this._onDateSelected(todayStr);
      });
      body.querySelector('.cal-picker-cancel').addEventListener('click', () => {
        this._cal.view = 'days';
        this._render();
      });
      body.querySelectorAll('[data-pick-month]').forEach(btn => {
        btn.addEventListener('click', () => {
          this._cal.year  = this._cal.pickerYear;
          this._cal.month = parseInt(btn.dataset.pickMonth, 10);
          this._cal.view  = 'days';
          this._render();
        });
      });
    }
  }
}
