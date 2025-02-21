import dbg from 'debug';
import {
    BrowserController,
    BrowserRequestHandler,
    BrowserRequestType,
} from './controllers/BrowserController';
import {
    BrowserControllerFactory,
    BrowserPage,
} from './controllers/BrowserControllerFactory';
import { Mock } from './mock';
import {
    MockedResponse,
    MockOptions,
    RequestMatcher,
    ShorthandRequestMatcher,
} from './types';
import {
    addMockByPriority,
    createRequestMatcher,
    getCorsHeaders,
    printRequest,
    printResponse,
    sanitizeHeaders,
} from './utils';

const debug = dbg('mockiavelli:main');

const interceptedTypes: BrowserRequestType[] = ['xhr', 'fetch'];

export interface MockiavelliOptions {
    debug: boolean;
    baseUrl: string;
    ignoreTrailingSlashes: boolean;
}

export class Mockiavelli {
    private readonly baseUrl: string = '';
    private mocks: Mock[] = [];
    private controller: BrowserController;

    constructor(page: BrowserPage, options: Partial<MockiavelliOptions> = {}) {
        this.controller = BrowserControllerFactory.createForPage(
            page,
            this.onRequest
        );

        if (options.baseUrl) {
            this.baseUrl = options.baseUrl;
        }

        if (options.debug) {
            dbg.enable('mockiavelli:*');
        }

        if (options.ignoreTrailingSlashes){
            // let pageURL = page.getURL();
            // pageURL = pageURL.replace(/\/+$/, "");
            // page.setURL(pageURL)
        }

        debug('Initialized');
    }

    public static async setup(
        page: BrowserPage,
        options: Partial<MockiavelliOptions> = {}
    ): Promise<Mockiavelli> {
        const instance = new Mockiavelli(page, options);
        await instance.enable();
        return instance;
    }

    public async enable(): Promise<void> {
        await this.controller.startInterception();
    }

    public async disable(): Promise<void> {
        await this.controller.stopInterception();
    }

    public mock<TResponseBody = any>(
        matcher: RequestMatcher,
        response: MockedResponse<TResponseBody>,
        options?: Partial<MockOptions>
    ): Mock {
        const matcherWithBaseUrl = {
            ...matcher,
            url: this.baseUrl + matcher.url,
        };
        const mock = new Mock(matcherWithBaseUrl, response, { ...options });
        addMockByPriority(this.mocks, mock);
        return mock;
    }

    public mockGET<TResponseBody = any>(
        matcher: ShorthandRequestMatcher,
        response: MockedResponse<TResponseBody>,
        options?: Partial<MockOptions>
    ): Mock {
        return this.mock(
            createRequestMatcher(matcher, 'GET'),
            response,
            options
        );
    }

    public mockPOST<TResponseBody = any>(
        matcher: ShorthandRequestMatcher,
        response: MockedResponse<TResponseBody>,
        options?: Partial<MockOptions>
    ): Mock {
        return this.mock(
            createRequestMatcher(matcher, 'POST'),
            response,
            options
        );
    }

    public mockPUT<TResponseBody = any>(
        matcher: ShorthandRequestMatcher,
        response: MockedResponse<TResponseBody>,
        options?: Partial<MockOptions>
    ): Mock {
        return this.mock(
            createRequestMatcher(matcher, 'PUT'),
            response,
            options
        );
    }

    public mockDELETE<TResponseBody = any>(
        matcher: ShorthandRequestMatcher,
        response: MockedResponse<TResponseBody>,
        options?: Partial<MockOptions>
    ): Mock {
        return this.mock(
            createRequestMatcher(matcher, 'DELETE'),
            response,
            options
        );
    }

    public mockPATCH<TResponseBody = any>(
        matcher: ShorthandRequestMatcher,
        response: MockedResponse<TResponseBody>,
        options?: Partial<MockOptions>
    ): Mock {
        return this.mock(
            createRequestMatcher(matcher, 'PATCH'),
            response,
            options
        );
    }

    public removeMock(mock: Mock): Mock | void {
        const index = this.mocks.indexOf(mock);
        if (index > -1) {
            return this.mocks.splice(index, 1)[0];
        }
    }

    private onRequest: BrowserRequestHandler = async (
        request,
        respond,
        skip
    ): Promise<void> => {
        debug(`> req: ${printRequest(request)} `);

        // Handle preflight requests
        if (request.method === 'OPTIONS') {
            return await respond({
                status: 204,
                headers: sanitizeHeaders(getCorsHeaders(request)),
            });
        }

        for (const mock of this.mocks) {
            const response = mock.getResponseForRequest(request);

            if (response) {
                const status = response.status || 200;

                // Convert response body to Buffer.
                // A bug in puppeteer causes stalled response when body is equal to "" or undefined.
                // Providing response as Buffer fixes it.
                let body: Buffer;
                let contentType: string | undefined;

                if (typeof response.body === 'string') {
                    body = Buffer.from(response.body);
                } else if (
                    response.body === undefined ||
                    response.body === null
                ) {
                    body = Buffer.alloc(0);
                } else {
                    try {
                        body = Buffer.from(JSON.stringify(response.body));
                        contentType = 'application/json; charset=utf-8';
                    } catch (e) {
                        // Response body in either not JSON-serializable or something else
                        // that cannot be handled. In this case we throw an error
                        console.error('Could not serialize response body', e);
                        throw e;
                    }
                }

                // Set default value of Content-Type header
                const headers = sanitizeHeaders({
                    'content-length': String(body.length),
                    'content-type': contentType,
                    ...getCorsHeaders(request),
                    ...response.headers,
                });

                try {
                    await respond({
                        status,
                        headers,
                        body,
                    });
                    debug(`< res: ${printResponse(status, headers, body)}`);
                    return;
                } catch (e) {
                    console.error(
                        `Failed to reply with mocked response for ${printRequest(
                            request
                        )}`
                    );
                    console.error(e);
                    throw e;
                }
            }
        }

        const should404 = interceptedTypes.includes(request.type);

        // Request was not matched - log error and return 404
        if (should404) {
            debug(`< res: status=404`);
            console.error(
                `Mock not found for request: ${printRequest(request)}`
            );
            return respond({
                status: 404,
                body: 'No mock provided for request',
            });
        }

        // Do not intercept non xhr/fetch requests
        debug(`< res: continue`);
        try {
            return await skip();
        } catch (e) {
            console.error(e);
            // Request could be already handled so ignore this error
            return;
        }
    };
}
