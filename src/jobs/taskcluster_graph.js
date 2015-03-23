import instantiate from '../try/instantiate'
import request from 'superagent-promise';
import slugid from 'slugid';
import taskcluster from 'taskcluster-client';
import fs from 'mz/fs';
import fsPath from 'path';
import mustache from 'mustache';
import * as projectConfig from '../project_scopes';
import assert from 'assert';

import Path from 'path';
import Base from './base';
import URL from 'url';

const GRAPH_RETIRES = 2;
const GRAPH_INTERVAL = 5000;
const GRAPH_REQ_TIMEOUT = 30000;

/**
Parses given url into path and host parts.


  parseUrl('https://hg.mozilla.org/try/');
  // => { host: 'https://hg.mozilla.org', path: '/try' }

*/
function parseUrl(url) {
  let parsed = URL.parse(url);
  let path = Path.resolve(parsed.path);

  path = (path === '/') ? '' : path;

  return {
    path,
    host: `${parsed.protocol || 'http'}//${parsed.host}`
  };
}

/**
Fetch a task graph from a url (retires included...)
*/
async function fetchGraph(job, url) {
  assert(url, 'url is required');
  job.log(`fetching graph ${url}`);
  let currentRetry = 0;
  while (currentRetry++ < GRAPH_RETIRES) {
    try {
      let res = await request.get(url).
        timeout(GRAPH_REQ_TIMEOUT).
        buffer(true).
        end();

      if (res.error) throw res.error;
      return res.text;
    } catch (e) {
      job.log(`Error fetching graph ${e.stack}`);
      let sleep = currentRetry * GRAPH_INTERVAL;
      // wait for a bit before retrying...
      await new Promise((accept) => setTimeout(accept, sleep));
    }
  }
  throw new Error(`Could not fetch graph at ${url}`);
}

export default class TaskclusterGraphJob extends Base {
  async work(job) {
    let { revision_hash, pushref, repo } = job.data;
    let push = await this.runtime.pushlog.getOne(repo.url, pushref.id);
    let lastChangeset = push.changesets[push.changesets.length - 1];

    let repositoryUrlParts = parseUrl(repo.url);
    let urlVariables = {
      // These values are defined in projects.yml
      alias: repo.alias,
      revision: lastChangeset.node,
      path: repositoryUrlParts.path,
      host: repositoryUrlParts.host
    };

    let graphUrl = projectConfig.url(this.config.try, repo.alias, urlVariables);
    job.log('Fetching url (%s) for %s push id %d ', graphUrl, repo.alias, push.id);
    let graphText = await fetchGraph(job, graphUrl);

    let variables = {
      owner: push.user,
      source: graphUrl,
      revision: lastChangeset.node,
      project: repo.alias,
      revision_hash,
      comment: lastChangeset.desc,
      pushlog_id: String(push.id),
      url: repo.url,
      importScopes: true
    };

    let graph;
    try {
      graph = instantiate(graphText, variables);
    } catch (e) {
      job.log("Error creating graph due to yaml syntax errors...");
      // Even though we won't end up doing anything overly useful we still need
      // to convey some status to the end user ... The instantiate error should
      // be safe to pass as it is simply some yaml error.
      let errorGraphUrl =
        mustache.render(this.config.try.errorTaskUrl, urlVariables);
      let errorGraph = await fetchGraph(job, errorGraphUrl);
      graph = instantiate(errorGraph, Object.assign(variables, {
        error: e.stack
      }));
    }

    let id = slugid.v4();
    let scopes = projectConfig.scopes(this.config.try, repo.alias);

    let scheduler = new taskcluster.Scheduler({
      credentials: this.config.taskcluster.credentials,
      authorizedScopes: scopes
    });

    // Assign maximum level of scopes to the graph....
    graph.scopes = scopes;

    job.log('Posting job with id %s and scopes', id, graph.scopes.join(', '));
    try {
      await scheduler.createTaskGraph(id, graph);
    } catch (e) {
      console.log(JSON.stringify(e, null, 2))
      throw e;
    }
  }
}
