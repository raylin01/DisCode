const customId =
    "new_session:runner_my-macbook-pro_6d2415f354d2:%2FUsers%2Fray%2FDocuments%2Ftesttest";

console.log(`Testing customId: ${customId}`);

if (customId.startsWith("prompt_")) console.log("Matches prompt_");
else if (customId.startsWith("create_folder_"))
    console.log("Matches create_folder_");
else if (customId.startsWith("session_runner_"))
    console.log("Matches session_runner_");
else if (customId.startsWith("session_cli_"))
    console.log("Matches session_cli_");
else if (customId.startsWith("session_plugin_"))
    console.log("Matches session_plugin_");
else if (customId.startsWith("new_session:"))
    console.log("Matches new_session:");
else console.log("No match found");
