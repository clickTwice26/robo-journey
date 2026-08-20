/**
 * Turning the workspace into something a model can read.
 *
 * This is most of what separates a useful answer from a generic one. Asked "why is my LED not
 * lighting", a model with no context can only recite the usual reasons; a model that can see there
 * is no series resistor between D13 and the anode says so.
 *
 * Two constraints shape everything here. The context is paid for by the token, so it has to be
 * dense -- and it is assembled from a project the user can put anything into, so it has to be
 * bounded. A sketch is truncated, a netlist of a thousand nodes is summarised, and nothing is
 * interpolated into the prompt without a length limit.
 */
import { splitTerminal } from '@robo-journey/parts';
/** Ceilings, so one enormous project cannot produce one enormous bill. */
const MAX_SKETCH_CHARS = 6000;
const MAX_PARTS = 60;
const MAX_WIRES = 120;
const MAX_FAULTS = 20;
function truncate(text, limit, what) {
    if (text.length <= limit)
        return text;
    return `${text.slice(0, limit)}\n... [${what} truncated, ${text.length - limit} more characters]`;
}
/**
 * The circuit as a netlist rather than as a list of wires.
 *
 * "D13 connects to R1.a, and R1.b connects to LED1.anode" is a list of facts a reader has to
 * assemble. Grouping terminals that are electrically the same point states the thing that
 * actually matters, and it is how anyone who reads schematics thinks about a circuit.
 */
function describeNets(project) {
    const parent = new Map();
    const find = (a) => {
        let root = a;
        while (parent.get(root) !== undefined && parent.get(root) !== root)
            root = parent.get(root);
        return root;
    };
    const union = (a, b) => {
        parent.set(find(a), find(b));
    };
    for (const terminal of [project.wires.flatMap((w) => [w.from, w.to])].flat()) {
        if (!parent.has(terminal))
            parent.set(terminal, terminal);
    }
    for (const wire of project.wires.slice(0, MAX_WIRES))
        union(wire.from, wire.to);
    const nets = new Map();
    for (const terminal of parent.keys()) {
        const root = find(terminal);
        nets.set(root, [...(nets.get(root) ?? []), terminal]);
    }
    const lines = [...nets.values()]
        .filter((members) => members.length > 1)
        .map((members, index) => `  net ${index + 1}: ${members.sort().join(', ')}`);
    if (lines.length === 0)
        return '  (nothing is wired together yet)';
    return lines.join('\n');
}
function describeParts(project) {
    if (project.parts.length === 0)
        return '  (the canvas is empty)';
    return project.parts
        .slice(0, MAX_PARTS)
        .map((part) => {
        const props = Object.entries(part.props ?? {})
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(' ');
        return `  ${part.id}: ${part.type}` + (props ? ` (${props})` : '');
    })
        .join('\n');
}
/**
 * Voltages worth mentioning.
 *
 * All of them would be hundreds of numbers and mostly noise. The ones on a part's own pins are
 * what somebody is asking about when they ask why something is not working.
 */
function describeVoltages(context) {
    const voltages = context.voltages;
    if (!voltages)
        return '';
    const interesting = Object.entries(voltages)
        .filter(([terminal]) => {
        const { partId } = splitTerminal(terminal);
        return context.project.parts.some((part) => part.id === partId);
    })
        .slice(0, 40)
        .map(([terminal, volts]) => `  ${terminal}: ${volts.toFixed(2)} V`);
    return interesting.length > 0 ? `\nMeasured now:\n${interesting.join('\n')}\n` : '';
}
/**
 * Everything the assistant is told about the workspace.
 *
 * Plain text rather than JSON: a model reads prose about a circuit better than it reads a
 * serialised object, and it costs fewer tokens to say the same thing.
 */
export function describeWorkspace(context) {
    const { project, faults = [], simulation } = context;
    const sketch = project.sketch
        .map((file) => `--- ${file.name} ---\n${file.contents}`)
        .join('\n\n');
    const faultLines = faults.length > 0
        ? faults
            .slice(0, MAX_FAULTS)
            .map((fault) => `  [${fault.severity}] ${fault.subject}: ${fault.message}`)
            .join('\n')
        : '  (none)';
    const state = simulation
        ? `${simulation.compiled ? 'firmware compiled' : 'not compiled'}, ` +
            `${simulation.running ? 'running' : 'stopped'} at ${simulation.seconds.toFixed(3)} s`
        : 'not started';
    const overflow = [];
    if (project.parts.length > MAX_PARTS) {
        overflow.push(`${project.parts.length - MAX_PARTS} more parts`);
    }
    if (project.wires.length > MAX_WIRES) {
        overflow.push(`${project.wires.length - MAX_WIRES} more wires`);
    }
    return `Project: ${project.name || 'Untitled'}
Simulation: ${state}

Parts on the canvas:
${describeParts(project)}

Electrical connections (terminals joined by a wire are one node):
${describeNets(project)}
${describeVoltages(context)}
Problems the simulator is currently reporting:
${faultLines}

Sketch:
${truncate(sketch, MAX_SKETCH_CHARS, 'sketch')}
${overflow.length > 0 ? `\n(Not shown: ${overflow.join(', ')}.)\n` : ''}`;
}
//# sourceMappingURL=context.js.map