import { 
    RoonApi,
    RoonApiStatus,
    RoonCore, 
    RoonSubscriptionResponse, 
    RoonExtensionDescription, 
    ProvidedRoonServices,
    RequestedRoonServices,
    RoonApiTransportOutputs,
    RoonApiTransportZones,
    WSConnectOptions
} from './interfaces';
import { RoonKit } from './RoonKit';
import EventEmitter from "events";
import { TransientObject } from './internals';

export type RoonServiceRequired  = 'not_required' | 'required' | 'optional';

export interface RoonExtensionOptions {
    description: RoonExtensionDescription;
    log_level?: 'none' | 'all';
    RoonApiBrowse?: RoonServiceRequired;
    RoonApiImage?: RoonServiceRequired;
    RoonApiTransport?: RoonServiceRequired;
    subscribe_outputs?: boolean;
    subscribe_zones?: boolean;
}

export interface RoonExtension {
    on(eventName: 'core_paired', listener: (core: RoonCore) => void): this;
    off(eventName: 'core_paired', listener: (core: RoonCore) => void): this;
    once(eventName: 'core_paired', listener: (core: RoonCore) => void): this;
    emit(eventName: 'core_paired', core: RoonCore): boolean;

    on(eventName: 'core_unpaired', listener: (core: RoonCore) => void): this;
    off(eventName: 'core_unpaired', listener: (core: RoonCore) => void): this;
    once(eventName: 'core_unpaired', listener: (core: RoonCore) => void): this;
    emit(eventName: 'core_unpaired', core: RoonCore): boolean;

    on(eventName: 'subscribe_outputs', listener: (core: RoonCore, response: RoonSubscriptionResponse, body: RoonApiTransportOutputs) => void): this;
    off(eventName: 'subscribe_outputs', listener: (core: RoonCore, response: RoonSubscriptionResponse, body: RoonApiTransportOutputs) => void): this;
    once(eventName: 'subscribe_outputs', listener: (core: RoonCore, response: RoonSubscriptionResponse, body: RoonApiTransportOutputs) => void): this;
    emit(eventName: 'subscribe_outputs', core: RoonCore, response: RoonSubscriptionResponse, body: RoonApiTransportOutputs): boolean;

    on(eventName: 'subscribe_zones', listener: (core: RoonCore, response: RoonSubscriptionResponse, body: RoonApiTransportZones) => void): this;
    off(eventName: 'subscribe_zones', listener: (core: RoonCore, response: RoonSubscriptionResponse, body: RoonApiTransportZones) => void): this;
    once(eventName: 'subscribe_zones', listener: (core: RoonCore, response: RoonSubscriptionResponse, body: RoonApiTransportZones) => void): this;
    emit(eventName: 'subscribe_zones', core: RoonCore, response: RoonSubscriptionResponse, body: RoonApiTransportZones): boolean;
}

/**
 * Wrapper around the Roon API that simplifies initializing services and subscribing to zones.
 */
export class RoonExtension extends EventEmitter {
    private _options: RoonExtensionOptions;
    private readonly _api: RoonApi;
    private readonly _status: RoonApiStatus;
    private _core?: TransientObject<RoonCore>;

    /**
     * Creates a new `RoonExtension` instance.
     * @param options Settings used to configure the extension.
     */
    constructor(options: RoonExtensionOptions) {
        super();

        // Assign default options
        this._options = {
            ...options
        };

        // Transport service is required if there are any subscriptions
        const hasSubscriptions  = this._options.subscribe_outputs || this._options.subscribe_zones;
        if (hasSubscriptions) {
            this._options.RoonApiTransport = 'required';
        }

        // Create API
        this._api = RoonKit.createRoonApi({
            ...options.description,
            log_level: options.log_level,
            core_paired: (newCore) => {
                const core = this._core!.resolve(newCore);
                this.emit("core_paired", core);

                // Setup subscriptions
                
                if (this._options.subscribe_outputs) {
                    core.services.RoonApiTransport.subscribe_outputs((r, b) => this.emit("subscribe_outputs", core, r, b));
                }

                if (this._options.subscribe_zones) {
                    core.services.RoonApiTransport.subscribe_zones((r, b) => this.emit("subscribe_zones", core, r, b));
                }
            },
            core_unpaired: (oldCore) => {
                this.emit("core_unpaired", oldCore);
                this._core!.dispose();
                this._core = new TransientObject();
            }
        });

        this._status = new RoonKit.RoonApiStatus(this._api);
    }

    /**
     * Returns the extensions RoonApi instance.
     */
    public get api(): RoonApi {
        return this._api;
    }

    /**
     * Initializes the extension's services and begins discovery.
     * @param provided_services Optional. Additional services provided by extension. RoonApiState is already provided so DO NOT add this service.
     */
    public start_discovery(provided_services: ProvidedRoonServices[] = []): void {
        this.instantiateCore();

        this.initializeServices(provided_services);
        
        // Start discovery
        this._api.start_discovery();
    }

    /**
     * Initializes the extension's services and attempts to pair with a Roon core via Websocket
     * @param options Websocket connection options.
     * @param provided_services Optional. Additional services provided by extension. RoonApiState is already provided so DO NOT add this service.
     */
    public ws_connect(options: WSConnectOptions, provided_services: ProvidedRoonServices[] = []) {
        this.instantiateCore();

        this.initializeServices(provided_services);

        this._api.ws_connect(options);
    }

    /**
     * Sets the current status message for the extension.
     * 
     * @remarks
     * If logging is enabled the message will also be written to the console.
     * @param message Extensions status message.
     * @param is_error Optional. If true an error occurred.
     */
    public set_status(message: string, is_error: boolean = false): void {
        this._status.set_status(message, is_error);
        if (this._options.log_level != 'none') {
            if (is_error) {
                console.error(`Extension Error: ${message}`);
            } else {
                console.log(`Extension Status: ${message}`);
            }
        }
    }

    /**
     * Sets new options before discovery is started.
     * 
     * @remarks
     * Used primarily by additional components that want to ensure the services they depend on are
     * initialized.
     * 
     * Can only be called before `start_discovery()` is called.
     * @param options Options to apply.
     */
    public update_options(options: Partial<RoonExtensionOptions>): void {
        if (this._core) {
            throw new Error(`RoonExtension: Can't update options after discovery has been started.`);
        }

        this._options = Object.assign(this._options, options);
    }

    /**
     * Returns the current RoonCore. If there isn't one paired it waits.
     * @returns The current RoonCore that's paired.
     */
    public get_core(): Promise<RoonCore> {
        const transient = this.ensureStarted();
        return transient.getObject();
    } 

    private ensureStarted(): TransientObject<RoonCore> {
        if (!this._core) {
            throw new Error(`RoonExtension: Discovery hasn't been started yet. Call start_discovery() first.`);
        }

        return this._core;
    }

    private requireService(setting: RoonServiceRequired | undefined, svc: {new (): RequestedRoonServices}, required_services: {new (): RequestedRoonServices}[], optional_services: {new (): RequestedRoonServices}[]): void {
        if (setting != undefined) {
            switch (setting) {
                case 'required':
                    required_services.push(svc);
                    break;
                case 'optional':
                    optional_services.push(svc);
                    break;
            }
        }
    }

    private instantiateCore() {
        if (this._core) {
            throw new Error(`RoonExtension: Discovery has already been started.`);
        }

        // Initialize transient object for to hold paired core
        this._core = new TransientObject();
    }
    
    private initializeServices(provided_services: ProvidedRoonServices[]) {
        // Add RoonApiStatus to list of provided services.
        provided_services.push(this._status);

        // Build list of required & optional services.
        const required_services: {new (): RequestedRoonServices}[] = [];
        const optional_services: {new (): RequestedRoonServices}[] = [];
        this.requireService(this._options.RoonApiBrowse, RoonKit.RoonApiBrowse, required_services, optional_services);
        this.requireService(this._options.RoonApiImage, RoonKit.RoonApiImage, required_services, optional_services);
        this.requireService(this._options.RoonApiTransport, RoonKit.RoonApiTransport, required_services, optional_services);
        
        // Initialize services
        this._api.init_services({ required_services, optional_services, provided_services });

    }
}
