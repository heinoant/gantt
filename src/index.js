import date_utils from './date_utils';
import { $, createSVG } from './svg_utils';
import Bar from './bar';
import Arrow from './arrow';
import Popup from './popup';
import './gantt.scss';

const VIEW_MODE = {
    QUARTER_DAY: 'Quarter Day',
    HALF_DAY: 'Half Day',
    DAY: 'Day',
    WEEK: 'Week',
    MONTH: 'Month',
    YEAR: 'Year',
};

export default class Gantt {
    constructor(wrapper, tasks, options) {
        this.tasks = tasks;
        this.current_location = false;
        this.setup_wrapper(wrapper);
        this.setup_options(options);
        this.setup_tasks(tasks);
        // initialize with default view mode
        this.change_view_mode();
        this.bind_events();
    }

    debounce(func, wait) {
        let timeout;
        return function () {
            const context = this;
            const args = arguments;
            clearTimeout(timeout);
            timeout = setTimeout(function () {
                func.apply(context, args);
            }, wait);
        };
    }

    setup_wrapper(element) {
        let svg_element, wrapper_element;

        // CSS Selector is passed
        if (typeof element === 'string') {
            element = document.querySelector(element);
        }

        // get the SVGElement
        if (element instanceof HTMLElement) {
            wrapper_element = element;
            svg_element = element.querySelector('svg');
        } else if (element instanceof SVGElement) {
            svg_element = element;
        } else {
            throw new TypeError(
                'Frappé Gantt only supports usage of a string CSS selector,' +
                    " HTML DOM element or SVG DOM element for the 'element' parameter"
            );
        }

        // svg element
        if (!svg_element) {
            // create it
            this.$svg = createSVG('svg', {
                append_to: wrapper_element,
                class: 'gantt',
            });
        } else {
            this.$svg = svg_element;
            this.$svg.classList.add('gantt');
        }

        // wrapper element
        this.$container = document.createElement('div');
        this.$container.classList.add('gantt-container');

        const parent_element = this.$svg.parentElement;
        parent_element.appendChild(this.$container);
        this.$container.appendChild(this.$svg);

        // popup wrapper
        this.popup_wrapper = document.createElement('div');
        this.popup_wrapper.classList.add('popup-wrapper');
        this.$container.appendChild(this.popup_wrapper);
    }

    setup_options(options) {
        const default_options = {
            header_height: 50,
            column_width: 30,
            step: 24,
            view_modes: [...Object.values(VIEW_MODE)],
            bar_height: 20,
            bar_corner_radius: 3,
            arrow_curve: 5,
            padding: 18,
            view_mode: 'Day',
            date_format: 'YYYY-MM-DD',
            popup_trigger: 'click',
            custom_popup_html: null,
            language: 'en',
            sortable: 'false',
        };
        this.options = Object.assign({}, default_options, options);
    }

    setup_tasks(tasks) {
        this.visible_tasks = tasks.filter(
            (task) => task.visible || task.visible === undefined
        );

        this.visible_tasks.map((task, i) => {
            task._start = date_utils.parse(task.start);
            task._end = date_utils.parse(task.end);

            if (date_utils.diff(task._end, task._start, 'year') > 10) {
                task.end = null;
            }

            // cache index
            task._index = i;

            // invalid dates
            if (!task.start && !task.end) {
                const today = date_utils.today();
                task._start = today;
                task._end = date_utils.add(today, 2, 'day');
            }

            if (!task.start && task.end) {
                task._start = date_utils.add(task._end, -2, 'day');
            }

            if (task.start && !task.end) {
                task._end = date_utils.add(task._start, 2, 'day');
            }

            // if hours is not set, assume the last day is full day
            // e.g: 2018-09-09 becomes 2018-09-09 23:59:59
            const task_end_values = date_utils.get_date_values(task._end);
            if (task_end_values.slice(3).every((d) => d === 0)) {
                task._end = date_utils.add(task._end, 24, 'hour');
            }

            // invalid flag
            if (!task.start || !task.end) {
                task.invalid = true;
            }

            // dependencies
            if (typeof task.dependencies === 'string' || !task.dependencies) {
                let deps = [];
                if (task.dependencies) {
                    deps = task.dependencies
                        .split(',')
                        .map((d) => d.trim())
                        .filter((d) => d);
                }
                task.dependencies = deps;
            }

            // uids
            if (!task.id) {
                task.id = generate_id(task);
            }

            return task;
        });

        this.setup_dependencies();
        this.setup_ancestors();
    }

    updateTaskVisibility(task, visibility) {
        task.visible = visibility;

        // Also update visibility in the original tasks array
        const originalTask = this.originalTasks.find((t) => t.id === task.id);
        if (originalTask) {
            originalTask.visible = visibility;
        }
    }

    setup_dependencies() {
        this.dependency_map = {};
        for (let t of this.tasks) {
            for (let d of t.dependencies) {
                this.dependency_map[d] = this.dependency_map[d] || [];
                this.dependency_map[d].push(t.id);
            }
        }
    }

    //make a map of tasks to their reverse dependencies with ancestors
    setup_ancestors() {
        this.ancestor_map = {};
        for (let t of this.tasks) {
            for (let d of t.dependencies) {
                this.ancestor_map[t.id] = this.ancestor_map[t.id] || [];
                this.ancestor_map[t.id].push(d);
                if (this.ancestor_map[d]) {
                    this.ancestor_map[t.id] = this.ancestor_map[t.id].concat(
                        this.ancestor_map[d]
                    );
                }
            }
        }
    }

    refresh(tasks) {
        this.setup_tasks(tasks);
        this.change_view_mode();
    }

    change_view_mode(mode = this.options.view_mode) {
        this.update_view_scale(mode);
        this.setup_dates();
        this.render();
        // fire viewmode_change event
        this.trigger_event('view_change', [mode]);
    }

    update_view_scale(view_mode) {
        this.options.view_mode = view_mode;

        if (view_mode === VIEW_MODE.DAY) {
            this.options.step = 24;
            this.options.column_width = 38;
        } else if (view_mode === VIEW_MODE.HALF_DAY) {
            this.options.step = 24 / 2;
            this.options.column_width = 38;
        } else if (view_mode === VIEW_MODE.QUARTER_DAY) {
            this.options.step = 24 / 4;
            this.options.column_width = 38;
        } else if (view_mode === VIEW_MODE.WEEK) {
            this.options.step = 24 * 7;
            this.options.column_width = 140;
        } else if (view_mode === VIEW_MODE.MONTH) {
            this.options.step = 24 * 30;
            this.options.column_width = 120;
        } else if (view_mode === VIEW_MODE.YEAR) {
            this.options.step = 24 * 365;
            this.options.column_width = 120;
        }
    }

    scale_view_mode(zoomValue) {
        const view_modes = this.options.view_modes;

        if (zoomValue > 0) {
            this.change_view_mode(
                view_modes[view_modes.indexOf(this.options.view_mode) - 1]
            );
        } else if (zoomValue < 0 && this.options.column_width > 15) {
            this.change_view_mode(
                view_modes[view_modes.indexOf(this.options.view_mode) + 1]
            );
        }
    }

    setup_dates() {
        this.setup_gantt_dates();
        this.setup_date_values();
    }

    setup_gantt_dates() {
        this.gantt_start = this.gantt_end = null;

        for (let task of this.tasks) {
            // set global start and end date
            if (!this.gantt_start || task._start < this.gantt_start) {
                this.gantt_start = task._start;
            }
            if (!this.gantt_end || task._end > this.gantt_end) {
                this.gantt_end = task._end;
            }
        }

        this.gantt_start = date_utils.start_of(this.gantt_start, 'day');
        this.gantt_end = date_utils.start_of(this.gantt_end, 'day');

        // add date padding on both sides
        if (this.view_is(VIEW_MODE.YEAR)) {
            const gantt_start = new Date(
                date_utils.format(
                    date_utils.add(this.gantt_start, -6, 'year'),
                    'YYYY'
                )
            );
            this.gantt_start = gantt_start;
            this.gantt_end = date_utils.add(this.gantt_end, 6, 'year');
        } else if (this.view_is(VIEW_MODE.MONTH)) {
            this.gantt_start = date_utils.add(this.gantt_start, -8, 'month');
            this.gantt_end = date_utils.add(this.gantt_end, 8, 'month');
        } else {
            this.gantt_start = date_utils.add(this.gantt_start, -2, 'month');
            this.gantt_end = date_utils.add(this.gantt_end, 2, 'month');
        }
    }

    setup_date_values() {
        this.dates = [];
        let cur_date = null;

        while (cur_date === null || cur_date < this.gantt_end) {
            if (!cur_date) {
                cur_date = date_utils.clone(this.gantt_start);
            } else {
                if (this.view_is(VIEW_MODE.YEAR)) {
                    cur_date = date_utils.add(cur_date, 1, 'year');
                } else if (this.view_is(VIEW_MODE.MONTH)) {
                    cur_date = date_utils.add(cur_date, 1, 'month');
                } else {
                    cur_date = date_utils.add(
                        cur_date,
                        this.options.step,
                        'hour'
                    );
                }
            }
            this.dates.push(cur_date);
        }
    }

    bind_events() {
        this.bind_grid_click();
        this.bind_bar_events();
        this.bind_scroll();
    }

    render() {
        this.clear();

        this.setup_layers();
        this.make_grid();
        this.make_dates();
        this.make_bars();
        this.make_arrows();
        this.map_arrows_on_bars();
        this.set_width();
        this.set_scroll_position();
    }

    setup_layers() {
        this.layers = {};
        const layers = ['grid', 'arrow', 'progress', 'bar', 'details', 'date'];
        // make group layers
        for (let layer of layers) {
            this.layers[layer] = createSVG('g', {
                class: layer,
                append_to: this.$svg,
            });
        }
    }

    make_grid() {
        this.make_grid_background();
        this.make_grid_rows();
        this.make_grid_header();
        this.make_grid_ticks();
        this.make_grid_highlights();
    }

    make_grid_background() {
        const grid_width = this.dates.length * this.options.column_width;
        const grid_height =
            this.options.header_height +
            this.options.padding +
            (this.options.bar_height + this.options.padding) *
                this.tasks.length;

        createSVG('rect', {
            x: 0,
            y: 0,
            width: grid_width,
            height: grid_height,
            class: 'grid-background',
            append_to: this.layers.grid,
        });

        $.attr(this.$svg, {
            height: grid_height + this.options.padding + 100,
            width: '100%',
        });
    }

    make_grid_rows() {
        const rows_layer = createSVG('g', { append_to: this.layers.grid });
        const lines_layer = createSVG('g', { append_to: this.layers.grid });

        const row_width = this.dates.length * this.options.column_width;
        const row_height = this.options.bar_height + this.options.padding;

        let row_y = this.options.header_height + this.options.padding / 2;

        for (let task of this.tasks) {
            createSVG('rect', {
                x: 0,
                y: row_y,
                width: row_width,
                height: row_height,
                data_row: task.id,
                class: 'grid-row',
                append_to: rows_layer,
            });

            createSVG('line', {
                x1: 0,
                y1: row_y + row_height,
                x2: row_width,
                y2: row_y + row_height,
                class: 'row-line',
                append_to: lines_layer,
            });

            row_y += this.options.bar_height + this.options.padding;
        }
    }

    make_grid_header() {
        const header_width = this.dates.length * this.options.column_width;
        const header_height = this.options.header_height + 10;
        createSVG('rect', {
            x: 0,
            y: 0,
            width: header_width,
            height: header_height,
            class: 'grid-header',
            append_to: this.layers.date,
        });
    }

    make_grid_ticks() {
        let tick_x = 0;
        let tick_y = this.options.header_height + this.options.padding / 2;
        let tick_height =
            (this.options.bar_height + this.options.padding) *
            this.tasks.length;

        for (let date of this.dates) {
            let tick_class = 'tick';
            // thick tick for monday
            if (this.view_is(VIEW_MODE.DAY) && date.getDate() === 1) {
                tick_class += ' thick';
            }
            // thick tick for first week
            if (
                this.view_is(VIEW_MODE.WEEK) &&
                date.getDate() >= 1 &&
                date.getDate() < 8
            ) {
                tick_class += ' thick';
            }
            // thick ticks for quarters
            if (this.view_is(VIEW_MODE.MONTH) && date.getMonth() % 3 === 0) {
                tick_class += ' thick';
            }

            createSVG('path', {
                d: `M ${tick_x} ${tick_y} v ${tick_height}`,
                class: tick_class,
                append_to: this.layers.grid,
            });

            if (this.view_is(VIEW_MODE.MONTH)) {
                tick_x +=
                    (date_utils.get_days_in_month(date) *
                        this.options.column_width) /
                    30;
            } else {
                tick_x += this.options.column_width;
            }
        }
    }

    make_grid_highlights() {
        // highlight today's date
        if (this.view_is(VIEW_MODE.DAY)) {
            const x =
                (date_utils.diff(date_utils.today(), this.gantt_start, 'hour') /
                    this.options.step) *
                this.options.column_width;
            const y = 0;

            const width = this.options.column_width;
            const height =
                (this.options.bar_height + this.options.padding) *
                    this.tasks.length +
                this.options.header_height +
                this.options.padding / 2;

            createSVG('rect', {
                x,
                y,
                width,
                height,
                class: 'today-highlight',
                append_to: this.layers.grid,
            });
        }
    }

    make_dates() {
        for (let date of this.get_dates_to_draw()) {
            createSVG('text', {
                x: date.lower_x,
                y: date.lower_y,
                innerHTML: date.lower_text,
                class: 'lower-text',
                append_to: this.layers.date,
            });

            if (date.upper_text) {
                const $upper_text = createSVG('text', {
                    x: date.upper_x,
                    y: date.upper_y,
                    innerHTML: date.upper_text,
                    class: 'upper-text',
                    append_to: this.layers.date,
                });

                // remove out-of-bound dates
                if (
                    $upper_text.getBBox().x2 > this.layers.grid.getBBox().width
                ) {
                    $upper_text.remove();
                }
            }
        }
    }

    get_dates_to_draw() {
        const monthPerYears = {};

        if (this.options.view_mode === 'Month') {
            this.dates.forEach((date) => {
                if (monthPerYears[date.getFullYear()]) {
                    monthPerYears[date.getFullYear()] += 1;
                } else {
                    monthPerYears[date.getFullYear()] = 1;
                }
            });
        }
        const dates = this.dates.map((date, i) => {
            const last_date = i >= 1 ? this.dates[i - 1] : null;
            return this.get_date_info(date, last_date, i, monthPerYears);
        });
        return dates;
    }

    get_date_info(date, last_date, i, monthPerYears) {
        const first_process = last_date === null;
        const date_text = {
            'Quarter Day_lower': date_utils.format(
                date,
                'HH',
                this.options.language
            ),
            'Half Day_lower': date_utils.format(
                date,
                'HH',
                this.options.language
            ),
            Day_lower:
                first_process || date.getDate() !== last_date.getDate()
                    ? date_utils.format(date, 'D', this.options.language)
                    : '',
            Week_lower:
                first_process || date.getMonth() !== last_date.getMonth()
                    ? date_utils.format(date, 'D MMM', this.options.language)
                    : date_utils.format(date, 'D', this.options.language),
            Month_lower: date_utils.format(date, 'MMMM', this.options.language),
            Year_lower: date_utils.format(date, 'YYYY', this.options.language),
            'Quarter Day_upper':
                first_process || date.getDate() !== last_date.getDate()
                    ? date_utils.format(date, 'D MMM', this.options.language)
                    : '',
            'Half Day_upper':
                first_process || date.getDate() !== last_date.getDate()
                    ? first_process || date.getMonth() !== last_date.getMonth()
                        ? date_utils.format(
                              date,
                              'D MMM',
                              this.options.language
                          )
                        : date_utils.format(date, 'D', this.options.language)
                    : '',
            Day_upper:
                first_process || date.getMonth() !== last_date.getMonth()
                    ? date_utils.format(date, 'MMMM', this.options.language)
                    : '',
            Week_upper:
                first_process || date.getMonth() !== last_date.getMonth()
                    ? date_utils.format(
                          date,
                          `MMMM${
                              i < 5 || date.getMonth() === 0 ? ' YYYY' : ''
                          }`,
                          this.options.language
                      )
                    : '',
            Month_upper:
                first_process || date.getFullYear() !== last_date.getFullYear()
                    ? date_utils.format(date, 'YYYY', this.options.language)
                    : '',
            Year_upper:
                first_process || date.getFullYear() !== last_date.getFullYear()
                    ? date_utils.format(date, 'YYYY', this.options.language)
                    : '',
        };

        const base_pos = {
            x: i * this.options.column_width,
            lower_y: this.options.header_height,
            upper_y: this.options.header_height - 25,
        };

        const x_pos = {
            'Quarter Day_lower': 0,
            'Quarter Day_upper': (this.options.column_width * 4) / 2,
            'Half Day_lower': 0,
            'Half Day_upper': (this.options.column_width * 2) / 2,
            Day_lower: this.options.column_width / 2,
            Day_upper: (this.options.column_width * 30) / 2,
            Week_lower: 0,
            Week_upper: (this.options.column_width * 4) / 2,
            Month_lower: this.options.column_width / 2,
            Month_upper:
                (this.options.column_width *
                    monthPerYears[date.getFullYear()]) /
                2,
            Year_lower: this.options.column_width / 2,
            Year_upper: (this.options.column_width * 30) / 2,
        };

        return {
            upper_text: date_text[`${this.options.view_mode}_upper`],
            lower_text: date_text[`${this.options.view_mode}_lower`],
            upper_x: base_pos.x + x_pos[`${this.options.view_mode}_upper`],
            upper_y: base_pos.upper_y,
            lower_x: base_pos.x + x_pos[`${this.options.view_mode}_lower`],
            lower_y: base_pos.lower_y,
        };
    }

    make_bars() {
        this.bars = this.tasks.map((task) => {
            const bar = new Bar(this, task);
            return bar;
        });
        this.visible_bars = this.visible_tasks.map((task) => {
            const bar = new Bar(this, task);
            this.layers.bar.appendChild(bar.group);
            return bar;
        });
    }

    make_arrows() {
        this.arrows = [];
        for (let task of this.visible_tasks) {
            let arrows = [];
            arrows = task.dependencies
                .map((task_id) => {
                    const dependency = this.get_task(task_id);
                    if (!dependency) return;
                    const arrow = new Arrow(
                        this,
                        this.visible_bars[dependency._index], // from_task
                        this.visible_bars[task._index] // to_task
                    );
                    this.layers.arrow.appendChild(arrow.element);
                    return arrow;
                })
                .filter(Boolean); // filter falsy values
            this.arrows = this.arrows.concat(arrows);
        }
    }

    map_arrows_on_bars() {
        for (let bar of this.visible_bars) {
            bar.arrows = this.arrows.filter((arrow) => {
                return (
                    arrow.from_task.task.id === bar.task.id ||
                    arrow.to_task.task.id === bar.task.id
                );
            });
        }
    }

    set_width() {
        const cur_width = this.$svg.getBoundingClientRect().width;
        const actual_width = this.$svg
            .querySelector('.grid .grid-row')
            .getAttribute('width');
        if (cur_width < actual_width) {
            this.$svg.setAttribute('width', actual_width);
        }
    }

    bind_scroll() {
        $.on(
            this.$svg.parentElement,
            'scroll',
            this.debounce(this.handle_scroll.bind(this), 50)
        );
    }

    handle_scroll(e) {
        const parent_element = this.$svg.parentElement;

        if (!parent_element) return;

        const content_width = this.$svg.clientWidth;
        const container_width = parent_element.offsetWidth;
        const scroll_position = parent_element.scrollLeft;
        const scroll_percentage =
            (scroll_position + container_width / 2) / content_width;

        const time_difference =
            this.gantt_end.getTime() - this.gantt_start.getTime();
        const time_offset = scroll_percentage * time_difference;
        const middle_date = new Date(this.gantt_start.getTime() + time_offset);

        this.current_location = middle_date;
    }

    set_scroll_position() {
        const parent_element = this.$svg.parentElement;

        if (!parent_element) return;

        if (!this.current_location) {
            const hours_before_first_task = date_utils.diff(
                this.get_oldest_starting_date(),
                this.gantt_start,
                'hour'
            );

            const scroll_pos =
                (hours_before_first_task / this.options.step) *
                    this.options.column_width -
                this.options.column_width;

            parent_element.scrollLeft = scroll_pos;
        } else {
            const time_difference =
                this.gantt_end.getTime() - this.gantt_start.getTime();
            const time_offset =
                this.current_location.getTime() - this.gantt_start.getTime();

            const scroll_percentage = time_offset / time_difference;

            const newScrollPosition =
                Math.round(this.$svg.clientWidth * scroll_percentage) -
                parent_element.offsetWidth / 2;

            parent_element.scrollLeft = newScrollPosition;
        }
    }

    bind_grid_click() {
        // add
        let is_dragging = false;
        let x_on_start = 0;
        // ...
        $.on(
            this.$svg,
            this.options.popup_trigger,
            '.grid-row, .grid-header',
            () => {
                this.unselect_all();
                this.hide_popup();
            }
        );
        // add
        $.on(this.$svg, 'mousedown', '.grid-row, .today-highlight', (e) => {
            is_dragging = true;
            x_on_start = e.offsetX;
            if (this.$svg.parentElement) {
                this.$svg.parentElement.style.cursor = 'move';
            }
        });
        $.on(this.$svg, 'mousemove', '.grid-row, .today-highlight', (e) => {
            if (!is_dragging) {
                return;
            }
            const dx = e.offsetX - x_on_start;
            const parent_element = this.$svg.parentElement;
            if (!parent_element) return;
            parent_element.style.cursor = 'move';
            parent_element.scrollLeft -= dx * 1.5;
            x_on_start = e.offsetX;
        });

        document.addEventListener('mouseup', (e) => {
            if (this.$svg.parentElement) {
                this.$svg.parentElement.style.cursor = 'default';
            }
            is_dragging = false;
            x_on_start = 0;
        });
        // ...
    }

    sort_bars() {
        const changed_bars = [];
        if (!this.bars) {
            return changed_bars;
        }
        this.bars = this.bars.sort((b0, b1) => {
            return b0.$bar.getY() - b1.$bar.getY();
        });

        this.tasks = this.bars.map((b, i) => {
            const task = b.task;
            if (task._index !== i) {
                changed_bars.push(b);
            }
            task._index = i;
            return task;
        });
        return changed_bars;
    }

    bind_bar_events() {
        let is_dragging = false;
        let x_on_start = 0;
        let y_on_start = 0;
        let is_resizing_left = false;
        let is_resizing_right = false;
        let parent_bar_id = null;
        let bars = []; // instanceof Bars, the dragged bar and its children
        let parent_bars = [];
        const min_y = this.options.header_height;
        const max_y =
            this.options.header_height +
            this.tasks.length *
                (this.options.bar_height + this.options.padding);
        this.bar_being_dragged = null; // instanceof dragged bar

        function action_in_progress() {
            return is_dragging || is_resizing_left || is_resizing_right;
        }
        // Event listener for clicking on a caret. Toggles collapse
        $.on(this.$svg, 'click', '.caret', (e, caretElement) => {
            this.hide_popup();
            const parentBarWrapper = caretElement.closest('.bar-wrapper');
            if (parentBarWrapper) {
                const parentTaskId = parentBarWrapper.getAttribute('data-id');
                const parentBar = this.get_task(parentTaskId);
                const dependentTasks =
                    this.get_all_dependent_tasks(parentTaskId);

                if (parentBar.collapsed) {
                    parentBar.collapsed = false;
                } else {
                    parentBar.collapsed = true;
                }

                dependentTasks.forEach((task_id) => {
                    const task = this.get_task(task_id, this.tasks);

                    if (
                        parentBar.collapsed == true ||
                        this.get_task(task.dependencies[0]).collapsed == true
                    ) {
                        task.visible = false;
                    } else {
                        task.visible = true;
                    }
                });
                this.refresh(this.tasks);
            }
        });

        $.on(this.$svg, 'mousedown', '.bar-wrapper, .handle', (e, element) => {
            const bar_wrapper = $.closest('.bar-wrapper', element);

            if (element.classList.contains('left')) {
                is_resizing_left = true;
            } else if (element.classList.contains('right')) {
                is_resizing_right = true;
            } else if (element.classList.contains('bar-wrapper')) {
                is_dragging = true;
            }

            bar_wrapper.classList.add('active');

            x_on_start = e.offsetX;
            y_on_start = e.offsetY;

            parent_bar_id = bar_wrapper.getAttribute('data-id');
            const ids = [
                parent_bar_id,
                ...this.get_all_dependent_tasks(parent_bar_id),
            ];
            bars = ids.map((id) => {
                const bar = this.get_bar(id);
                if (parent_bar_id === id) {
                    this.bar_being_dragged = bar;
                }
                const $bar = bar.$bar;
                $bar.ox = $bar.getX();
                $bar.oy = $bar.getY();
                $bar.owidth = $bar.getWidth();
                $bar.finaldx = 0;
                $bar.finaldy = 0;
                return bar;
            });
            parent_bars = this.get_all_parent_tasks(parent_bar_id).map(
                (bar) => {
                    const $bar = bar.$bar;
                    $bar.ox = $bar.getX();
                    $bar.oy = $bar.getY();
                    $bar.owidth = $bar.getWidth();
                    $bar.finaldx = 0;
                    $bar.finaldy = 0;
                    return bar;
                }
            );
        });

        $.on(this.$svg, 'mousemove', (e) => {
            if (!action_in_progress()) return;
            const dx = e.offsetX - x_on_start;
            const dy = e.offsetY - y_on_start;

            this.hide_popup();

            // update the dragged bar
            const bar_being_dragged = this.bar_being_dragged;
            bar_being_dragged.$bar.finaldx = this.get_snap_position(dx);
            if (is_resizing_left) {
                bar_being_dragged.update_bar_position({
                    x:
                        bar_being_dragged.$bar.ox +
                        bar_being_dragged.$bar.finaldx,
                    width:
                        bar_being_dragged.$bar.owidth -
                        bar_being_dragged.$bar.finaldx,
                });
            } else if (is_resizing_right) {
                bar_being_dragged.update_bar_position({
                    width:
                        bar_being_dragged.$bar.owidth +
                        bar_being_dragged.$bar.finaldx,
                });
            } else if (is_dragging) {
                let y = bar_being_dragged.$bar.oy + dy;
                if (y < min_y) {
                    y = min_y;
                } else if (y > max_y) {
                    y = max_y;
                }
                bar_being_dragged.update_bar_position({
                    x:
                        bar_being_dragged.$bar.ox +
                        bar_being_dragged.$bar.finaldx,
                    y: this.options.sortable ? y : null,
                });
            }

            // update project and tag bars when resizing or moving children
            parent_bars.forEach((ancestor_bar) => {
                if (
                    ancestor_bar.task.type == 'project' ||
                    ancestor_bar.task.type == 'tag'
                ) {
                    let max_x = -Infinity;
                    let min_x = Infinity;
                    this.get_all_dependent_tasks(ancestor_bar.task.id).forEach(
                        (bar_id) => {
                            const bar = this.get_bar(bar_id);
                            if (bar.$bar.getX() < min_x)
                                min_x = bar.$bar.getX();
                            if (bar.$bar.getWidth() + bar.$bar.getX() > max_x)
                                max_x = bar.$bar.getWidth() + bar.$bar.getX();
                        }
                    );
                    if (min_x > ancestor_bar.$bar.ox) {
                        ancestor_bar.update_bar_position({
                            x: min_x,
                            width: max_x - min_x,
                        });
                    } else {
                        ancestor_bar.update_bar_position({
                            width: max_x - ancestor_bar.$bar.ox,
                        });
                    }
                    ancestor_bar.date_changed();
                }
            });

            // update children
            bars.forEach((bar) => {
                if (bar.task.id === parent_bar_id) {
                    return;
                }
                const $bar = bar.$bar;
                $bar.finaldx = this.get_snap_position(dx);
                this.hide_popup();
                if (is_resizing_left) {
                    bar.update_bar_position({
                        x: $bar.ox + $bar.finaldx,
                    });
                } else if (is_dragging) {
                    bar.update_bar_position({
                        x: $bar.ox + $bar.finaldx,
                    });
                }
            });

            // update y pos
            if (
                this.options.sortable &&
                is_dragging &&
                Math.abs(dy - bar_being_dragged.$bar.finaldy) >
                    bar_being_dragged.height
            ) {
                this.sort_bars().map((bar) => {
                    const y = bar.compute_y();
                    if (bar.task.id === parent_bar_id) {
                        bar.$bar.finaldy = y - bar.$bar.oy;
                        return;
                    }
                    bar.date_changed();
                    bar.update_bar_position({ y: y });
                });
            }
        });

        document.addEventListener('mouseup', (e) => {
            const dy = e.offsetY - y_on_start;
            if (is_dragging || is_resizing_left || is_resizing_right) {
                bars.forEach((bar) => {
                    bar.group.classList.remove('active');

                    const $bar = bar.$bar;
                    if ($bar.finaldx) {
                        bar.date_changed();
                        bar.set_action_completed();
                    }
                });
                const $bar = this.bar_being_dragged.$bar;
                if (this.options.sortable && dy !== $bar.finaldy) {
                    this.bar_being_dragged.update_bar_position({
                        y: $bar.oy + $bar.finaldy,
                    });
                    this.bar_being_dragged.date_changed();
                }
            }

            this.bar_being_dragged = null;
            is_dragging = false;
            is_resizing_left = false;
            is_resizing_right = false;
        });

        // Sticky date header
        $.on(this.$container, 'scroll', (e) => {
            this.layers.date.setAttribute(
                'transform',
                'translate(0,' + e.currentTarget.scrollTop + ')'
            );
        });

        this.bind_bar_progress();
    }

    bind_bar_progress() {
        let x_on_start = 0;
        let y_on_start = 0;
        let is_resizing = null;
        let bar = null;
        let $bar_progress = null;
        let $bar = null;

        $.on(this.$svg, 'mousedown', '.handle.progress', (e, handle) => {
            is_resizing = true;
            x_on_start = e.offsetX;
            y_on_start = e.offsetY;

            const $bar_wrapper = $.closest('.bar-wrapper', handle);
            const id = $bar_wrapper.getAttribute('data-id');
            bar = this.get_bar(id);

            $bar_progress = bar.$bar_progress;
            $bar = bar.$bar;

            $bar_progress.finaldx = 0;
            $bar_progress.owidth = $bar_progress.getWidth();
            $bar_progress.min_dx = -$bar_progress.getWidth();
            $bar_progress.max_dx = $bar.getWidth() - $bar_progress.getWidth();
        });

        $.on(this.$svg, 'mousemove', (e) => {
            if (!is_resizing) return;
            let dx = e.offsetX - x_on_start;
            let dy = e.offsetY - y_on_start;

            if (dx > $bar_progress.max_dx) {
                dx = $bar_progress.max_dx;
            }
            if (dx < $bar_progress.min_dx) {
                dx = $bar_progress.min_dx;
            }

            const $handle = bar.$handle_progress;
            $.attr($bar_progress, 'width', $bar_progress.owidth + dx);
            $.attr($handle, 'points', bar.get_progress_polygon_points());
            $bar_progress.finaldx = dx;
        });

        $.on(this.$svg, 'mouseup', () => {
            is_resizing = false;
            if (!($bar_progress && $bar_progress.finaldx)) return;
            bar.progress_changed();
            bar.set_action_completed();
        });
    }

    get_all_dependent_tasks(task_id) {
        let out = [];
        let to_process = [task_id];
        while (to_process.length) {
            const deps = to_process.reduce((acc, curr) => {
                acc = acc.concat(this.dependency_map[curr]);
                return acc;
            }, []);

            out = out.concat(deps);
            to_process = deps.filter((d) => !to_process.includes(d));
        }

        return out.filter(Boolean);
    }

    get_all_parent_tasks(task_id) {
        const out = [];
        const to_process = [task_id];
        const processedTasks = new Set();

        while (to_process.length) {
            const deps = to_process.reduce((acc, curr) => {
                acc = acc.concat(this.ancestor_map[curr] || []);
                return acc;
            }, []);

            for (const dep of deps) {
                if (!processedTasks.has(dep)) {
                    processedTasks.add(dep);
                    const taskObject = this.get_bar(dep);

                    if (taskObject) {
                        out.push(taskObject);
                    }

                    to_process.push(dep);
                }
            }

            to_process.shift();
        }

        return out;
    }

    get_snap_position(dx) {
        let odx = dx,
            rem,
            position;

        if (this.view_is(VIEW_MODE.WEEK)) {
            rem = dx % (this.options.column_width / 7);
            position =
                odx -
                rem +
                (rem < this.options.column_width / 14
                    ? 0
                    : this.options.column_width / 7);
        } else if (this.view_is(VIEW_MODE.MONTH)) {
            rem = dx % (this.options.column_width / 30);
            position =
                odx -
                rem +
                (rem < this.options.column_width / 60
                    ? 0
                    : this.options.column_width / 30);
        } else {
            rem = dx % this.options.column_width;
            position =
                odx -
                rem +
                (rem < this.options.column_width / 2
                    ? 0
                    : this.options.column_width);
        }
        return position;
    }

    unselect_all() {
        [...this.$svg.querySelectorAll('.bar-wrapper')].forEach((el) => {
            el.classList.remove('active');
        });
    }

    view_is(modes) {
        if (typeof modes === 'string') {
            return this.options.view_mode === modes;
        }

        if (Array.isArray(modes)) {
            return modes.some((mode) => this.options.view_mode === mode);
        }

        return false;
    }

    get_task(id, tasks_array = this.tasks) {
        return tasks_array.find((task) => {
            return task.id === id;
        });
    }

    get_bar(id) {
        return this.visible_bars.find((bar) => {
            return bar.task.id === id;
        });
    }

    show_popup(options) {
        if (!this.popup) {
            this.popup = new Popup(
                this.popup_wrapper,
                this.options.custom_popup_html
            );
        }
        this.popup.show(options);
    }

    hide_popup() {
        this.popup && this.popup.hide();
    }

    trigger_event(event, args) {
        if (this.options['on_' + event]) {
            this.options['on_' + event].apply(null, args);
        }
    }

    get_oldest_starting_date() {
        return this.tasks
            .map((task) => task._start)
            .reduce((prev_date, cur_date) =>
                cur_date <= prev_date ? cur_date : prev_date
            );
    }

    clear() {
        this.$svg.innerHTML = '';
    }
}

Gantt.VIEW_MODE = VIEW_MODE;

function generate_id(task) {
    return task.name + '_' + Math.random().toString(36).slice(2, 12);
}
