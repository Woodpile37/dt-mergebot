import { HttpRequest, Context } from "@azure/functions";
import fetch from "node-fetch";
import { gql } from "@apollo/client/core";
import { Discussion, DiscussionWebhook } from "./types/discussions";
import { createMutation, client } from "./graphql-client";
import { reply } from "./util/reply";
import { httpLog, shouldRunRequest } from "./util/verify";
import { txt } from "./util/util";
import { getOwnersOfPackage } from "./pr-info";
import { fetchFile } from "./util/fetchFile";

export async function run(context: Context, req: HttpRequest) {
    httpLog(context, req);

    if (!(await shouldRunRequest(req, canHandleRequest))) {
        reply(context, 204, "Can't handle this request");
    }

    const { body, headers } = req;
    return handleTrigger({ event: headers["x-github-event"]!, action: body.action, body }, context);
}

export const canHandleRequest = (event: string, action: string) => {
    const name = "discussion";
    const actions = ["created", "edited"];
    return event == name && actions.includes(action);
};

const handleTrigger = (info: { event: string; action: string; body: DiscussionWebhook }, context: Context) => {
    const categoryID = info.body.discussion.category.slug;
    if (categoryID === "issues-with-a-types-package") {
        return pingAuthorsAndSetUpDiscussion(info.body.discussion);
    } else if (categoryID === "request-a-new-types-package" && info.action === "created") {
        return updateDiscordWithRequest(info.body.discussion);
    }
    return reply(context, 204, "Can't handle this specific request");
};

export function extractNPMReference(discussion: { title: string }) {
    const title = discussion.title;
    if (title.includes("[") && title.includes("]")) {
        const full = title.split("[")[1]!.split("]")[0];
        return full!.replace("@types/", "");
    }
    return undefined;
}

const couldNotFindMessage = txt`
  |Hi, we could not find a reference to the types you are talking about in this discussion. 
  |Please edit the title to include the name on npm inside square brackets.
  |
  |E.g.
  |- \`"[@typescript/vfs] Does not x, y"\`
  |- \`"Missing x inside [node]"\`
  |- \`"[express] Broken support for template types"\`
`;

const errorsGettingOwners = (str: string) =>  txt`
  |Hi, we could not find [${str}] in DefinitelyTyped, is there possibly a typo? 
`;

const couldNotFindOwners = (str: string) =>  txt`
  |Hi, we had an issue getting the owners for [${str}] - please raise an issue on DefinitelyTyped/dt-mergebot if this 
`;


const gotAReferenceMessage = (module: string, owners: string[]) => txt`
  |Thanks for the discussion about "${module}", some useful links for everyone:
  | 
  | - [npm](https://www.npmjs.com/package/${module})
  | - [DT](https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/types/${module})
  | - [Related discussions](https://github.com/DefinitelyTyped/DefinitelyTyped/issues?q=is%3Aopen+is%3Aissue+label%3A%22Pkg%3A+${module}%22/)
  |
  |Pinging the DT module owners: ${owners.join(", ")}.
`;


async function pingAuthorsAndSetUpDiscussion(discussion: Discussion) {
    const aboutNPMRef = extractNPMReference(discussion);
    if (!aboutNPMRef) {
        // Could not find a types reference
        await updateOrCreateMainComment(discussion, couldNotFindMessage);
    } else {
        const owners = await getOwnersOfPackage(aboutNPMRef, "master", fetchFile);
        if (owners instanceof Error) {
            await updateOrCreateMainComment(discussion, errorsGettingOwners(aboutNPMRef));
        }  else if (!owners) {
            await updateOrCreateMainComment(discussion, couldNotFindOwners(aboutNPMRef));
        } else {
            const message = gotAReferenceMessage(aboutNPMRef, owners);
            await updateOrCreateMainComment(discussion, message);
            await addLabel(discussion, "Pkg: " + aboutNPMRef, `Discussions related to ${aboutNPMRef}`);
        }
    }
}

async function updateDiscordWithRequest(discussion: Discussion) {
    const discordWebhookAddress = process.env.DT_MODULE_REQ_DISCORD_WEBHOOK;
    if (!discordWebhookAddress) throw new Error("DT_MODULE_REQ_DISCORD_WEBHOOK not set in ENV");

    // https://birdie0.github.io/discord-webhooks-guide/discord_webhook.html
    const webhook = {  content: `New DT Module requested:`, embeds: [ { title: discussion.title, url: discussion.html_url } ] };
    await fetch(discordWebhookAddress, { method: "POST", body: JSON.stringify(webhook), headers: { "content-type": "application/json" } });
}


async function updateOrCreateMainComment(discussion: Discussion, message: string) {
    const discussionComments = await getCommentsForDiscussionNumber(discussion.number);
    const previousComment = discussionComments.find(c => c.author.login === "typescript-bot");
    if (previousComment) {
        await client.mutate(createMutation<any>("updateDiscussionComment" as any, { body: message, commentId: previousComment.id }));
    } else {
        await client.mutate(createMutation<any>("addDiscussionComment" as any, { body: message, discussionId: discussion.node_id }));
    }
}

async function addLabel(discussion: Discussion, labelName: string, description?: string) {
    const existingLabel = await getLabelByName(labelName);
    let labelID = null;
    if (existingLabel.label && existingLabel.label.name === labelName) {
        labelID = existingLabel.label.id;
    } else {
        const color = "eeeeee";
        const newLabel = await client.mutate(createMutation("createLabel" as any, { name: labelName, repositoryId: existingLabel.repoID, color, description })) as any;
        labelID = newLabel.data.label.id;
    }
    await client.mutate(createMutation<any>("addLabelsToLabelable" as any, { labelableId: discussion.node_id, labelIds: [labelID] }));
}

async function getLabelByName(name: string) {
    const info = await client.query({
        query: gql`
          query GetLabel($name: String!) {
            repository(name: "DefinitelyTyped", owner: "DefinitelyTyped") {
              id
              name
              labels(query: $name, first: 1) {
                nodes {
                  id
                  name
                }
              }
            }
          }`,
        variables: { name },
        fetchPolicy: "no-cache",
    });

    const label: { id: string, name: string } | undefined =  info.data.repository.labels.nodes[0];
    return { repoID: info.data.repository.id, label };
}

async function getCommentsForDiscussionNumber(number: number) {
    const info = await client.query({
        query: gql`
          query GetDiscussionComments($discussionNumber: Int!) {
            repository(name: "DefinitelyTyped", owner: "DefinitelyTyped") {
              name
              discussion(number: $discussionNumber) {
                comments(first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
                  nodes {
                    author {
                      login
                    }
                    id
                    body
                  }
                }
              }
            }
          }`,
        variables: { discussionNumber: number },
        fetchPolicy: "no-cache",
    });

    return info.data.repository.discussion.comments.nodes as Array<{ author: { login: string}, body: string, id: string }>;
}
