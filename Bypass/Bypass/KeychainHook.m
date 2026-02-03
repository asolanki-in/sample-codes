// KeychainHook.m
// C function hooking for Security framework using fishhook

#import "KeychainHook.h"
#import "fishhook.h"
#import <objc/runtime.h>

// Original function pointers
static OSStatus (*original_SecItemAdd)(CFDictionaryRef attributes, CFTypeRef *result) = NULL;
static OSStatus (*original_SecItemCopyMatching)(CFDictionaryRef query, CFTypeRef *result) = NULL;
static OSStatus (*original_SecItemUpdate)(CFDictionaryRef query, CFDictionaryRef attributesToUpdate) = NULL;
static OSStatus (*original_SecItemDelete)(CFDictionaryRef query) = NULL;

// Bypass state
static BOOL _keychainBypassEnabled = YES;

// Mock storage (in-memory dictionary)
static NSMutableDictionary *_mockStorage = nil;

// Forward declarations for hooked functions
static BOOL hasBiometricProtection(CFDictionaryRef query);
static NSString* storageKeyFromQuery(CFDictionaryRef query);
static OSStatus hooked_SecItemAdd(CFDictionaryRef attributes, CFTypeRef *result);
static OSStatus hooked_SecItemCopyMatching(CFDictionaryRef query, CFTypeRef *result);
static OSStatus hooked_SecItemUpdate(CFDictionaryRef query, CFDictionaryRef attributesToUpdate);
static OSStatus hooked_SecItemDelete(CFDictionaryRef query);

@implementation KeychainHook

+ (void)load {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        [self initialize];
    });
}

+ (void)initialize {
    NSLog(@"[KeychainHook] Initializing Keychain hooks...");
    
    // Initialize mock storage
    _mockStorage = [NSMutableDictionary dictionary];
    
    // Rebind Security framework C functions using fishhook
    struct rebinding rebindings[] = {
        {"SecItemAdd", hooked_SecItemAdd, (void *)&original_SecItemAdd},
        {"SecItemCopyMatching", hooked_SecItemCopyMatching, (void *)&original_SecItemCopyMatching},
        {"SecItemUpdate", hooked_SecItemUpdate, (void *)&original_SecItemUpdate},
        {"SecItemDelete", hooked_SecItemDelete, (void *)&original_SecItemDelete}
    };
    
    rebind_symbols(rebindings, sizeof(rebindings)/sizeof(struct rebinding));
    
    NSLog(@"[KeychainHook] Keychain C functions hooked successfully");
}

+ (void)enableBypass:(BOOL)enabled {
    _keychainBypassEnabled = enabled;
    NSLog(@"[KeychainHook] Keychain bypass %@", enabled ? @"ENABLED" : @"DISABLED");
}

+ (BOOL)isBypassEnabled {
    return _keychainBypassEnabled;
}

+ (void)clearMockStorage {
    @synchronized(_mockStorage) {
        [_mockStorage removeAllObjects];
        NSLog(@"[KeychainHook] Mock storage cleared");
    }
}

+ (NSDictionary *)getMockStorageContents {
    @synchronized(_mockStorage) {
        return [_mockStorage copy];
    }
}

// Helper: Check if query has biometric protection
static BOOL hasBiometricProtection(CFDictionaryRef query) {
    if (!query) return NO;
    
    NSDictionary *dict = (__bridge NSDictionary *)query;
    
    // Check for access control with biometric flags
    id accessControl = dict[(__bridge id)kSecAttrAccessControl];
    if (accessControl) {
        NSLog(@"[KeychainHook] Detected kSecAttrAccessControl - BIOMETRIC PROTECTED");
        return YES;
    }
    
    // Check for accessibility attributes that suggest device-bound security
    id accessible = dict[(__bridge id)kSecAttrAccessible];
    if (accessible) {
        CFStringRef accessibleStr = (__bridge CFStringRef)accessible;
        if (CFEqual(accessibleStr, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly) ||
            CFEqual(accessibleStr, kSecAttrAccessibleWhenUnlockedThisDeviceOnly)) {
            NSLog(@"[KeychainHook] Detected device-bound accessibility - BIOMETRIC PROTECTED");
            return YES;
        }
    }
    
    return NO;
}

// Helper: Generate storage key from query
static NSString* storageKeyFromQuery(CFDictionaryRef query) {
    NSDictionary *dict = (__bridge NSDictionary *)query;
    
    NSString *service = dict[(__bridge id)kSecAttrService] ?: @"default";
    NSString *account = dict[(__bridge id)kSecAttrAccount] ?: @"default";
    NSString *className = @"unknown";
    
    id secClass = dict[(__bridge id)kSecClass];
    if (secClass) {
        if (CFEqual((__bridge CFTypeRef)secClass, kSecClassGenericPassword)) {
            className = @"GenericPassword";
        } else if (CFEqual((__bridge CFTypeRef)secClass, kSecClassInternetPassword)) {
            className = @"InternetPassword";
        }
    }
    
    return [NSString stringWithFormat:@"%@|%@|%@", className, service, account];
}

// Hooked SecItemAdd
static OSStatus hooked_SecItemAdd(CFDictionaryRef attributes, CFTypeRef *result) {
    NSLog(@"[KeychainHook] SecItemAdd called");
    
    if (_keychainBypassEnabled && hasBiometricProtection(attributes)) {
        NSLog(@"[KeychainHook] BYPASSING SecItemAdd - storing in mock storage");
        
        NSDictionary *dict = (__bridge NSDictionary *)attributes;
        NSString *key = storageKeyFromQuery(attributes);
        
        @synchronized(_mockStorage) {
            NSMutableDictionary *item = [NSMutableDictionary dictionary];
            
            // Store the data
            NSData *data = dict[(__bridge id)kSecValueData];
            if (data) {
                item[(__bridge id)kSecValueData] = data;
            }
            
            // Store all attributes
            [item addEntriesFromDictionary:dict];
            
            _mockStorage[key] = item;
            NSLog(@"[KeychainHook] Stored item with key: %@", key);
        }
        
        if (result) {
            *result = NULL;
        }
        
        return errSecSuccess;
    }
    
    // Not biometric-protected, use real Keychain
    if (original_SecItemAdd) {
        return original_SecItemAdd(attributes, result);
    }
    
    return errSecUnimplemented;
}

// Hooked SecItemCopyMatching
static OSStatus hooked_SecItemCopyMatching(CFDictionaryRef query, CFTypeRef *result) {
    NSLog(@"[KeychainHook] SecItemCopyMatching called");
    
    if (_keychainBypassEnabled && hasBiometricProtection(query)) {
        NSLog(@"[KeychainHook] BYPASSING SecItemCopyMatching - retrieving from mock storage");
        
        NSString *key = storageKeyFromQuery(query);
        NSDictionary *queryDict = (__bridge NSDictionary *)query;
        
        @synchronized(_mockStorage) {
            NSDictionary *storedItem = _mockStorage[key];
            
            if (!storedItem) {
                NSLog(@"[KeychainHook] Item not found in mock storage: %@", key);
                return errSecItemNotFound;
            }
            
            NSLog(@"[KeychainHook] Found item in mock storage: %@", key);
            
            if (result) {
                BOOL returnData = [queryDict[(__bridge id)kSecReturnData] boolValue];
                BOOL returnAttributes = [queryDict[(__bridge id)kSecReturnAttributes] boolValue];
                BOOL returnRef = [queryDict[(__bridge id)kSecReturnRef] boolValue];
                
                if (returnData) {
                    NSData *data = storedItem[(__bridge id)kSecValueData];
                    if (data) {
                        *result = CFBridgingRetain(data);
                        NSLog(@"[KeychainHook] Returning data (%lu bytes)", (unsigned long)[data length]);
                    }
                } else if (returnAttributes) {
                    *result = CFBridgingRetain(storedItem);
                    NSLog(@"[KeychainHook] Returning attributes");
                } else {
                    // Default: return data
                    NSData *data = storedItem[(__bridge id)kSecValueData];
                    if (data) {
                        *result = CFBridgingRetain(data);
                    }
                }
            }
            
            return errSecSuccess;
        }
    }
    
    // Not biometric-protected, use real Keychain
    if (original_SecItemCopyMatching) {
        return original_SecItemCopyMatching(query, result);
    }
    
    return errSecUnimplemented;
}

// Hooked SecItemUpdate
static OSStatus hooked_SecItemUpdate(CFDictionaryRef query, CFDictionaryRef attributesToUpdate) {
    NSLog(@"[KeychainHook] SecItemUpdate called");
    
    if (_keychainBypassEnabled && hasBiometricProtection(query)) {
        NSLog(@"[KeychainHook] BYPASSING SecItemUpdate - updating mock storage");
        
        NSString *key = storageKeyFromQuery(query);
        NSDictionary *updates = (__bridge NSDictionary *)attributesToUpdate;
        
        @synchronized(_mockStorage) {
            NSMutableDictionary *storedItem = [_mockStorage[key] mutableCopy];
            
            if (!storedItem) {
                NSLog(@"[KeychainHook] Item not found for update: %@", key);
                return errSecItemNotFound;
            }
            
            // Merge updates
            [storedItem addEntriesFromDictionary:updates];
            _mockStorage[key] = storedItem;
            
            NSLog(@"[KeychainHook] Updated item: %@", key);
        }
        
        return errSecSuccess;
    }
    
    // Not biometric-protected, use real Keychain
    if (original_SecItemUpdate) {
        return original_SecItemUpdate(query, attributesToUpdate);
    }
    
    return errSecUnimplemented;
}

// Hooked SecItemDelete
static OSStatus hooked_SecItemDelete(CFDictionaryRef query) {
    NSLog(@"[KeychainHook] SecItemDelete called");
    
    if (_keychainBypassEnabled && hasBiometricProtection(query)) {
        NSLog(@"[KeychainHook] BYPASSING SecItemDelete - deleting from mock storage");
        
        NSString *key = storageKeyFromQuery(query);
        
        @synchronized(_mockStorage) {
            if (_mockStorage[key]) {
                [_mockStorage removeObjectForKey:key];
                NSLog(@"[KeychainHook] Deleted item: %@", key);
                return errSecSuccess;
            } else {
                NSLog(@"[KeychainHook] Item not found for deletion: %@", key);
                return errSecItemNotFound;
            }
        }
    }
    
    // Not biometric-protected, use real Keychain
    if (original_SecItemDelete) {
        return original_SecItemDelete(query);
    }
    
    return errSecUnimplemented;
}

@end
