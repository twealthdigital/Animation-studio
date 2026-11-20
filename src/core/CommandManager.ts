export interface StudioCommand {
  readonly label: string;
  execute(): void;
  undo(): void;
}

/**
 * Undo/Redo command history stack with bounded capacity.
 */
export class CommandManager {
  private undoStack: StudioCommand[] = [];
  private redoStack: StudioCommand[] = [];
  private readonly maxHistory: number;

  constructor(maxHistory = 100) {
    this.maxHistory = maxHistory;
  }

  execute(command: StudioCommand): void {
    command.execute();
    this.pushExecuted(command);
  }

  /**
   * Records a command that was already applied (e.g., after dragging a gizmo or slider).
   */
  pushExecuted(command: StudioCommand): void {
    this.undoStack.push(command);
    if (this.undoStack.length > this.maxHistory) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  undo(): string | null {
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    cmd.undo();
    this.redoStack.push(cmd);
    return cmd.label;
  }

  redo(): string | null {
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    cmd.execute();
    this.undoStack.push(cmd);
    return cmd.label;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  getUndoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }

  getRedoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
