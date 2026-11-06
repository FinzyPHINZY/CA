export enum ElementType {
  SCENE_HEADING = 'scene_heading',
  ACTION = 'action',
  CHARACTER = 'character',
  DIALOGUE = 'dialogue',
  PARENTHETICAL = 'parenthetical',
  TRANSITION = 'transition',
}

const SCENE_HEADING_REGEX = /^(INT|EXT|INT\/EXT|EXT\/INT|I\/E)\.?/i;

export const buildSceneHeadingRegex = () => SCENE_HEADING_REGEX;

export const isAllCaps = (text: string) =>
  text === text.toUpperCase() && text.length > 1;

export interface ColumnCalibration {
  headingMaxLeft: number;
  characterLeft: number;
  characterTolerance: number;
  dialogueLeft: number;
  dialogueWidthMax: number;
  parentheticalLeft: number;
  transitionMinLeft: number;
  actionMaxLeft: number;
}

export const DEFAULT_COLUMN_CALIBRATION: ColumnCalibration = {
  headingMaxLeft: 160,
  characterLeft: 240,
  characterTolerance: 30,
  dialogueLeft: 260,
  dialogueWidthMax: 320,
  parentheticalLeft: 250,
  transitionMinLeft: 500,
  actionMaxLeft: 200,
};

export const classifyElementByPosition = (
  line: { left: number; width: number; text: string },
  calibration?: ColumnCalibration,
): ElementType => {
  const { left, width, text } = line;
  const config = calibration ?? DEFAULT_COLUMN_CALIBRATION;
  const trimmed = text.trim();

  if (SCENE_HEADING_REGEX.test(trimmed) && left <= config.headingMaxLeft + 20) {
    return ElementType.SCENE_HEADING;
  }

  if (
    isAllCaps(trimmed) &&
    trimmed.length <= 30 &&
    Math.abs(left - config.characterLeft) <= config.characterTolerance
  ) {
    return ElementType.CHARACTER;
  }

  if (
    trimmed.startsWith('(') &&
    trimmed.endsWith(')') &&
    Math.abs(left - config.parentheticalLeft) <= config.characterTolerance
  ) {
    return ElementType.PARENTHETICAL;
  }

  if (
    left >= config.dialogueLeft - config.characterTolerance &&
    left <= config.dialogueLeft + config.characterTolerance &&
    width < config.dialogueWidthMax + 80
  ) {
    return ElementType.DIALOGUE;
  }

  if (left >= config.transitionMinLeft) {
    return ElementType.TRANSITION;
  }

  if (left <= config.actionMaxLeft + 40) {
    return ElementType.ACTION;
  }

  return ElementType.ACTION;
};
