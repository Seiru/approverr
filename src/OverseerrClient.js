export default class OverseerrClient {
  constructor({ apiKey, url }) {
    this.apiKey = apiKey;
    this.url = url;
  }

  async getRequests() {
    const response = await fetch(`${this.url}/request?filter=pending&take=100`, {
      method: 'GET',
      headers: {
        'X-Api-Key': this.apiKey,
      },
    });

    return (await response.json()).results;
  }

  async updateRequest(requestId, rootFolder) {
    const response = await fetch(`${this.url}/request/${requestId}`, {
      method: 'PUT',
      headers: {
        'X-Api-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        rootFolder,
      }),
    });

    return await response.json();
  }

  async updateRequestStatus(requestId, status) {
    const response = await fetch(`${this.url}/request/${requestId}/${status}`, {
      method: 'POST',
      headers: {
        'X-Api-Key': this.apiKey,
      },
    });

    return await response.json();
  }

  async getMovieDetails(movieId) {
    const response = await fetch(`${this.url}/movie/${movieId}`, {
      method: 'GET',
      headers: {
        'X-Api-Key': this.apiKey,
      },
    });

    return await response.json();
  }

  async getTVDetails(tvId) {
    const response = await fetch(`${this.url}/tv/${tvId}`, {
      method: 'GET',
      headers: {
        'X-Api-Key': this.apiKey,
      },
    });

    return await response.json();
  }
}
