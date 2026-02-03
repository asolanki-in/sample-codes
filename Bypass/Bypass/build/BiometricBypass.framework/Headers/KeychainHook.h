// KeychainHook.h
// Header file for Keychain Security framework hooks

#import <Foundation/Foundation.h>
#import <Security/Security.h>

@interface KeychainHook : NSObject

+ (void)initialize;
+ (void)enableBypass:(BOOL)enabled;
+ (BOOL)isBypassEnabled;

// Mock storage management
+ (void)clearMockStorage;
+ (NSDictionary *)getMockStorageContents;

@end
