export const CLI_COMMAND_NAME = "lcode";
export const CLI_PROCESS_NAME = "lcode-cli";

interface ProcessTitleTarget {
  title: string;
}

export const setCliProcessTitle = (
  target: ProcessTitleTarget = process,
): void => {
  target.title = CLI_PROCESS_NAME;
};
