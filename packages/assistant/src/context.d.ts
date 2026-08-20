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
import { type Project } from '@robo-journey/parts';
export interface Fault {
    readonly code: string;
    readonly severity: string;
    readonly subject: string;
    readonly message: string;
}
export interface WorkspaceContext {
    readonly project: Project;
    readonly faults?: readonly Fault[];
    /** Whether firmware is loaded and running, and how far it has got. */
    readonly simulation?: {
        readonly running: boolean;
        readonly seconds: number;
        readonly compiled: boolean;
    };
    /** Voltages the user can currently see, by terminal. */
    readonly voltages?: Record<string, number>;
}
/**
 * Everything the assistant is told about the workspace.
 *
 * Plain text rather than JSON: a model reads prose about a circuit better than it reads a
 * serialised object, and it costs fewer tokens to say the same thing.
 */
export declare function describeWorkspace(context: WorkspaceContext): string;
//# sourceMappingURL=context.d.ts.map