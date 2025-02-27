import { Tables } from "@/supabase/types"
import {
  BuiltChatMessage,
  ChatMessage,
  ChatPayload,
  MessageImage
} from "@/types"
import { PluginID, pluginHelp } from "@/types/plugins"
import { encode } from "gpt-tokenizer"
import { GPT4 } from "./models/llm/openai-llm-list"
import endent from "endent"

const buildBasePrompt = (
  prompt: string,
  profileContext: string,
  workspaceInstructions: string,
  assistant: Tables<"assistants"> | null,
  selectedPlugin: PluginID | null
) => {
  let fullPrompt = ""

  if (assistant) {
    fullPrompt += `<INJECT ROLE>\nYou are not an AI. You are ${assistant.name}.\n</INJECT ROLE>\n\n`
  }

  if (profileContext) {
    fullPrompt += `User Info:\n${profileContext}\n\n`
  }

  if (workspaceInstructions) {
    fullPrompt += `System Instructions:\n${workspaceInstructions}\n\n`
  }

  if (prompt !== "You are a friendly, helpful AI assistant.") {
    fullPrompt += `User Instructions:\n${prompt}`
  }

  if (selectedPlugin === PluginID.WEB_SCRAPER) {
    fullPrompt += pluginHelp(selectedPlugin)
  }

  return fullPrompt
}

export const lastSequenceNumber = (chatMessages: ChatMessage[]) =>
  chatMessages.reduce(
    (max, msg) => Math.max(max, msg.message.sequence_number),
    0
  )

export async function buildFinalMessages(
  payload: ChatPayload,
  profile: Tables<"profiles">,
  chatImages: MessageImage[],
  selectedPlugin: PluginID | null
): Promise<BuiltChatMessage[]> {
  const {
    chatSettings,
    workspaceInstructions,
    chatMessages,
    assistant,
    messageFileItems
  } = payload

  const BUILT_PROMPT = buildBasePrompt(
    chatSettings.prompt,
    chatSettings.includeProfileContext ? profile.profile_context || "" : "",
    chatSettings.includeWorkspaceInstructions ? workspaceInstructions : "",
    assistant,
    selectedPlugin
  )

  let CHUNK_SIZE = chatSettings.contextLength
  if (chatSettings.model === GPT4.modelId) {
    CHUNK_SIZE = 12000
  } else if (chatSettings.model === "mistral-large") {
    // Adjusting the chunk size to comply with the content size limit imposed by Llama 3 (8192 max)
    CHUNK_SIZE = 8000
  } else if (chatSettings.model === "mistral-medium") {
    // Adjusting the chunk size to comply with the content size limit imposed by Llama 3 (8192 max)
    CHUNK_SIZE = 8000
  }

  if (selectedPlugin !== PluginID.NONE) {
    CHUNK_SIZE = 8000
  }

  const PROMPT_TOKENS = encode(chatSettings.prompt).length
  let remainingTokens = CHUNK_SIZE - PROMPT_TOKENS

  let usedTokens = 0
  usedTokens += PROMPT_TOKENS

  const lastUserMessage = chatMessages[chatMessages.length - 2].message.content
  const lastUserMessageContent = Array.isArray(lastUserMessage)
    ? lastUserMessage
        .map(item => (item.type === "text" ? item.text : ""))
        .join(" ")
    : lastUserMessage
  const lastUserMessageTokens = encode(lastUserMessageContent).length

  if (lastUserMessageTokens > CHUNK_SIZE) {
    throw new Error(
      "The message you submitted was too long, please submit something shorter."
    )
  }

  const processedChatMessages = chatMessages.map((chatMessage, index) => {
    const nextChatMessage = chatMessages[index + 1]

    if (nextChatMessage === undefined) {
      return chatMessage
    }

    if (chatMessage.fileItems.length > 0) {
      const retrievalText = buildRetrievalText(chatMessage.fileItems)

      return {
        message: {
          ...chatMessage.message,
          content:
            `User Query: "${chatMessage.message.content}"\n\nFile Content:\n${retrievalText}` as string
        },
        fileItems: []
      }
    }

    return chatMessage
  })

  const truncatedMessages: any[] = []

  for (let i = processedChatMessages.length - 1; i >= 0; i--) {
    const messageSizeLimit = Number(process.env.MESSAGE_SIZE_LIMIT || 12000)
    if (
      processedChatMessages[i].message.role === "assistant" &&
      // processedChatMessages[i].message.plugin !== PluginID.NONE &&
      processedChatMessages[i].message.content.length > messageSizeLimit
    ) {
      const messageSizeKeep = Number(process.env.MESSAGE_SIZE_KEEP || 2000)
      processedChatMessages[i].message = {
        ...processedChatMessages[i].message,
        content:
          processedChatMessages[i].message.content.slice(0, messageSizeKeep) +
          "\n... [output truncated]"
      }
    }
    const message = processedChatMessages[i].message

    const messageTokens = encode(message.content).length

    if (messageTokens <= remainingTokens) {
      remainingTokens -= messageTokens
      usedTokens += messageTokens
      truncatedMessages.unshift(message)
    } else {
      break
    }
  }

  let tempSystemMessage: Tables<"messages"> = {
    chat_id: "",
    content: BUILT_PROMPT,
    created_at: "",
    id: processedChatMessages.length + "",
    image_paths: [],
    model: payload.chatSettings.model,
    plugin: PluginID.NONE,
    role: "system",
    sequence_number: lastSequenceNumber(processedChatMessages) + 1,
    updated_at: "",
    user_id: ""
  }

  truncatedMessages.unshift(tempSystemMessage)

  const finalMessages: BuiltChatMessage[] = truncatedMessages.map(message => {
    let content

    if (message.image_paths.length > 0) {
      content = [
        {
          type: "text",
          text: message.content
        },
        ...message.image_paths.map((path: string) => {
          let formedUrl = ""

          if (path.startsWith("data")) {
            formedUrl = path
          } else {
            const chatImage = chatImages.find(image => image.path === path)

            if (chatImage) {
              formedUrl = chatImage.base64
            }
          }

          return {
            type: "image_url",
            image_url: {
              url: formedUrl
            }
          }
        })
      ]
    } else {
      content = message.content
    }

    return {
      role: message.role,
      content
    }
  })

  if (messageFileItems.length > 0 && selectedPlugin === PluginID.NONE) {
    const retrievalText = buildRetrievalText(messageFileItems)

    finalMessages[finalMessages.length - 2] = {
      ...finalMessages[finalMessages.length - 2],
      content: endent`Assist with the user's query: '${finalMessages[finalMessages.length - 2].content}' using uploaded files. 
      Each <BEGIN SOURCE>...<END SOURCE> section represents part of the overall file. 
      Assess each section for information pertinent to the query.
      
      \n\n${retrievalText}\n\n
      
      Draw insights directly from file content to provide specific guidance. 
      Ensure answers are actionable, focusing on practical relevance. 
      Highlight or address any ambiguities found in the content. 
      State clearly if information related to the query is not available.`
    }
  } else if (
    messageFileItems.length > 0 &&
    selectedPlugin !== PluginID.NONE &&
    selectedPlugin !== PluginID.AUTO_PLUGIN_SELECTOR
  ) {
    const retrievalText = buildRetrievalText(messageFileItems)

    finalMessages[finalMessages.length - 2] = {
      ...finalMessages[finalMessages.length - 2],
      content: endent`Assist with the user's query: '${finalMessages[finalMessages.length - 2].content}' using uploaded files. 
      Each <BEGIN SOURCE>...<END SOURCE> section represents part of the overall file. 
      Assess each section for information pertinent to the query.
      
      \n\n${retrievalText}\n\n
      
      Draw insights directly from file content to provide specific guidance. 
      Ensure answers are actionable, focusing on practical relevance. 
      Highlight or address any ambiguities found in the content. 
      State clearly if information related to the query is not available.`
    }
  }

  return finalMessages
}

function buildRetrievalText(fileItems: Tables<"file_items">[]) {
  const retrievalText = fileItems
    .map(item => `<BEGIN SOURCE>\n${item.content}\n</END SOURCE>`)
    .join("\n\n")

  return `${retrievalText}`
}

export function filterEmptyAssistantMessages(messages: any[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i].content.trim() === "") {
      messages.splice(i, 1)
    }
  }
}

export function ensureAssistantMessagesNotEmpty(messages: any[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i].content.trim() === "") {
      messages[i].content = "Sure."
    }
  }
}
