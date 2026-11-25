"""Draft helpers for the v0.6 installer; preparation never reads credential contents."""
import hashlib
import json
import math
import pathlib
from urllib.parse import urlsplit


def add_science_arguments(parser):
    parser.add_argument('--implementation', choices=['protocol_only', 'scientific_candidate'])
    parser.add_argument('--science-profile', type=pathlib.Path)
    parser.add_argument('--instance-file', type=pathlib.Path, help='Existing private instance shared by one Single/Multi pair')
    parser.add_argument('--horizon', type=int, default=2400)
    parser.add_argument('--reference', action='store_true', help='Install the keyless public-reference profile')
    parser.add_argument('--model')
    parser.add_argument('--context-window', type=int, default=1000000, help='Declared actual supported context, frozen with prices')
    parser.add_argument('--provider-api', default='openai-completions')
    parser.add_argument('--provider-profile', type=pathlib.Path, help='Explicit native provider metadata; credential environment names only')
    parser.add_argument('--price-table', type=pathlib.Path)
    parser.add_argument('--budget-usd', type=float)


def read_config(path):
    if any(part.lower() == 'secrets' for part in path.resolve().parts):
        raise ValueError('Configuration must not be read from the private credentials directory')
    return json.loads(path.read_text(encoding='utf8'))


def resolve_science_options(args, parser):
    implementation = args.implementation or ('scientific_candidate' if args.benchmark_version == 'v0.6' else 'protocol_only')
    scientific = args.benchmark_version == 'v0.6' and implementation == 'scientific_candidate'
    profile = read_config(args.science_profile) if args.science_profile else {}
    provider = read_config(args.provider_profile) if args.provider_profile else {}
    if not isinstance(profile, dict) or not isinstance(provider, dict):
        parser.error('Scientific and provider profiles must contain JSON objects')
    budget = None
    if args.benchmark_version != 'v0.6' and any([args.implementation, args.science_profile, args.instance_file, args.reference, args.price_table, args.budget_usd is not None]):
        parser.error('Scientific options require benchmark-version v0.6')
    if args.benchmark_version == 'v0.6':
        if not 0 < args.baseline_tick < args.final_tick < args.horizon:
            parser.error('Require 0 < baseline-tick < final-tick < horizon')
        if not scientific and args.mode != 'environment':
            parser.error('protocol_only supports environment mode')
        if args.reference and (not scientific or args.mode != 'environment'):
            parser.error('--reference requires a scientific keyless environment')
        if args.mode != 'environment' and not args.model:
            parser.error('Scientific model profiles need an explicit --model')
        if args.context_window < 1 or args.max_output_tokens < 1 or args.max_output_tokens >= args.context_window:
            parser.error('Model context/output limits are invalid')
    if provider:
        allowed = {'api', 'baseURL', 'headers', 'compat', 'models', 'reasoning', 'thinkingBudgets', 'cacheRetention', 'transport', 'timeoutMs', 'streamIdleTimeoutMs'}
        if not isinstance(provider, dict) or set(provider) - allowed:
            parser.error('Provider profile contains unsupported fields; use apiKeyEnv arguments, never literal credentials')
        headers = provider.get('headers') or {}
        if not isinstance(headers, dict) or any(not isinstance(name, str) or not isinstance(value, str) for name, value in headers.items()):
            parser.error('Provider headers must contain string metadata')
        if any(name.lower() in ('authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'cookie', 'set-cookie') for name in headers):
            parser.error('Provider credentials must be environment references')
        endpoint = urlsplit(provider.get('baseURL', args.base_url))
        if endpoint.scheme != 'https' or not endpoint.hostname or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
            parser.error('Provider baseURL must be HTTPS without credential, query or fragment')
        args.base_url = provider.get('baseURL', args.base_url)
    if args.price_table:
        table = read_config(args.price_table)
        if not isinstance(table, dict) or set(table) - {'prices', 'limitUsd'}:
            parser.error('Price table must contain prices and optional limitUsd')
        limit = args.budget_usd if args.budget_usd is not None else table.get('limitUsd')
        if not isinstance(limit, (float, int)) or not 0 < limit <= 1000000:
            parser.error('A positive explicit USD budget is required')
        budget = {'limitUsd': limit, 'prices': table.get('prices')}
        prices = budget['prices']
        fields = {'provider', 'model', 'inputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion', 'outputPerMillion', 'maxInputTokens', 'maxOutputTokens', 'verified', 'singleAttempt'}
        if not isinstance(prices, list) or not prices or any(not isinstance(p, dict) or set(p) != fields for p in prices):
            parser.error('Price table needs complete native route prices, verified flags and input/output bounds')
        if len({(p['provider'], p['model']) for p in prices}) != len(prices):
            parser.error('Duplicate price route')
        for price in prices:
            if any(isinstance(price[key], bool) or not isinstance(price[key], (float, int)) or not math.isfinite(price[key]) or price[key] < 0
                   for key in ('inputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion', 'outputPerMillion')):
                parser.error('Prices must be finite nonnegative USD per million tokens')
            if any(type(price[key]) is not int or price[key] < 1 for key in ('maxInputTokens', 'maxOutputTokens')):
                parser.error('Token bounds must be positive integers')
            if not all(isinstance(price[key], str) and price[key] for key in ('provider', 'model')) or type(price['verified']) is not bool or price['singleAttempt'] is not True:
                parser.error('Price routes require names, a verified boolean and singleAttempt=true')
    if scientific and args.mode != 'environment':
        if not budget or not isinstance(budget['prices'], list) or not budget['prices']:
            parser.error('Scientific model profiles need a frozen price table and whole-tree budget')
        aliases = ['intern-greenhouse', *[f'intern-greenhouse-{i}' for i in range(2, len(set([args.api_key_env, *args.extra_key_env])) + 1)]]
        for alias in aliases:
            price = next((p for p in budget['prices'] if p.get('provider') == alias and p.get('model') == args.model), None)
            if not price or price.get('verified') is not True or price.get('singleAttempt') is not True:
                parser.error('Every selected native route needs verified single-attempt prices and bounds')
            if price.get('maxInputTokens') != args.context_window or price.get('maxOutputTokens', 0) < args.max_output_tokens:
                parser.error('Price bounds must match the declared supported input context and cover output limits')
    return implementation, scientific, profile, provider, budget


def apply_model_profile(rows, args, provider):
    for row in rows:
        if row['id'] == 'llm-pi-ai':
            for native in row['config']['providers'].values():
                key_environment = native['apiKeyEnv']
                native.pop('compat', None)
                native.update(provider)
                native['apiKeyEnv'] = key_environment
                native['api'] = provider.get('api', args.provider_api)
                native['retryPolicy'] = {'mode': 'normal', 'maxRetries': 0}
                if not provider.get('models'):
                    native['models'] = [{'id': args.model, 'name': args.model, 'contextWindow': args.context_window, 'maxTokens': args.max_output_tokens}]
                selected = next((m for m in native['models'] if m.get('id') == args.model), None)
                if not selected or selected.get('contextWindow') != args.context_window or selected.get('maxTokens', 0) < args.max_output_tokens:
                    raise ValueError('Provider model metadata differs from frozen model/context/output settings')
        if row['id'] == 'compaction-basic':
            row['config']['maxTokens'] = args.max_output_tokens
    return [row for row in rows if row['id'] != 'llm-retry']


def profile_hash(rows):
    public = [row['config'] for row in rows if row['id'] in ['llm-pi-ai', 'compaction-basic']]
    return hashlib.sha256(json.dumps(public, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('utf8')).hexdigest()
