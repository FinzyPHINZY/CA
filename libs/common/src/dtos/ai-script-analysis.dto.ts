export class AiScriptAnalysisDTO {
  projectId: string;
  userId: string;
  mediaId: string;
  taskId: string;
  scriptIndex?: number; // Index of script in the project (0 for first script, 1 for second, etc.)
}
